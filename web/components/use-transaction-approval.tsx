"use client";

import type { Address, Instruction, Signature } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useState } from "react";
import type { AppClient } from "@/components/providers";
import { prepareTransaction } from "@/lib/held-program";

type PendingTransaction = {
  title: string;
  summary: string;
  instructions: readonly Instruction[];
  unitsConsumed: number | null;
  logs: string[];
  afterConfirmation?: (signature: Signature) => void | Promise<void>;
};

type ConfirmationState = "idle" | "confirming" | "confirmed" | "failed" | "unknown";

const CONFIRMATION_ATTEMPTS = 60;
const CONFIRMATION_POLL_INTERVAL_MS = 1_000;

export function useTransactionApproval() {
  const client = useClient<AppClient>();
  const wallet = useConnectedWallet(client);
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<Signature | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [confirmationState, setConfirmationState] =
    useState<ConfirmationState>("idle");

  async function prepare(
    title: string,
    summary: string,
    instructions: readonly Instruction[],
    afterConfirmation?: (signature: Signature) => void | Promise<void>,
  ) {
    if (
      signature &&
      (confirmationState === "confirming" || confirmationState === "unknown")
    ) {
      setIsOpen(true);
      setError(
        "A previous transaction is still awaiting confirmation. Check its status before starting another.",
      );
      return;
    }
    setIsOpen(true);
    setError(null);
    setSignature(null);
    setConfirmationState("idle");
    setPending(null);
    if (!wallet) {
      setError("Connect your Solana Devnet wallet before continuing.");
      return;
    }
    if (!wallet.supportedTransactionVersions.has(1)) {
      setError(
        "Your connected wallet does not support Solana transaction version 1. Update it before continuing.",
      );
      return;
    }
    if (!instructions.length) {
      setError("No transaction instructions were provided.");
      return;
    }
    setIsSimulating(true);
    try {
      const simulation = await prepareTransaction(client, instructions);
      setPending({
        title,
        summary,
        instructions,
        unitsConsumed: simulation.unitsConsumed,
        logs: simulation.logs,
        afterConfirmation,
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Transaction simulation failed.",
      );
    } finally {
      setIsSimulating(false);
    }
  }

  async function approve() {
    if (!pending || !wallet) return;
    setError(null);
    setIsSending(true);
    let submittedSignature: Signature | null = null;
    try {
      const result = await client.sendTransaction(pending.instructions);
      const confirmedSignature = result.context.signature;
      submittedSignature = confirmedSignature;
      setSignature(confirmedSignature);
      setConfirmationState("confirming");
      for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
        const status = await readStatus(confirmedSignature);
        if (status === "confirmed") {
          setConfirmationState("confirmed");
          setPending(null);
          runAfterConfirmation(pending.afterConfirmation, confirmedSignature);
          return;
        }
        if (status === "failed") {
          setConfirmationState("failed");
          setError("Solana reported that this transaction failed. No success is recorded.");
          return;
        }
        await new Promise((resolve) =>
          window.setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS),
        );
      }
      setConfirmationState("unknown");
    } catch (reason) {
      setConfirmationState(submittedSignature ? "unknown" : "failed");
      setError(
        reason instanceof Error
          ? `Transaction confirmation could not be verified: ${reason.message}`
          : "Transaction confirmation could not be verified. Check its status before retrying.",
      );
    } finally {
      setIsSending(false);
    }
  }

  async function checkStatus() {
    if (!signature) return;
    setError(null);
    setIsSending(true);
    try {
      const status = await readStatus(signature);
      if (status === "confirmed") {
        setConfirmationState("confirmed");
        setPending(null);
        if (pending?.afterConfirmation) {
          runAfterConfirmation(pending.afterConfirmation, signature);
        }
        return;
      }
      if (status === "failed") {
        setConfirmationState("failed");
        setError("Solana reported that this transaction failed.");
        return;
      }
      setConfirmationState("unknown");
      setError("No confirmed transaction status was found yet. Check again before retrying.");
    } catch (reason) {
      setConfirmationState("unknown");
      setError(
        reason instanceof Error
          ? `Could not check transaction status: ${reason.message}`
          : "Could not check transaction status. Try again.",
      );
    } finally {
      setIsSending(false);
    }
  }

  async function readStatus(
    transactionSignature: Signature,
  ): Promise<"pending" | "confirmed" | "failed"> {
    const response = await client.rpc
      .getSignatureStatuses([transactionSignature], {
        searchTransactionHistory: true,
      })
      .send();
    const status = response.value[0];
    if (!status) return "pending";
    if (status.err) return "failed";
    return status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
      ? "confirmed"
      : "pending";
  }

  function runAfterConfirmation(
    callback: PendingTransaction["afterConfirmation"],
    confirmedSignature: Signature,
  ) {
    if (!callback) return;
    void Promise.resolve()
      .then(() => callback(confirmedSignature))
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error
            ? `The transaction is confirmed, but its follow-up action failed: ${reason.message}`
            : "The transaction is confirmed, but its follow-up action failed.",
        );
      });
  }

  function close() {
    setIsOpen(false);
  }

  function reopen() {
    setIsOpen(true);
  }

  return {
    prepare,
    approve,
    close,
    pending,
    error,
    signature,
    confirmationState,
    checkStatus,
    isOpen,
    reopen,
    isSimulating,
    isSending,
    walletAddress: wallet?.account.address as Address | undefined,
  };
}

export function TransactionApprovalDialog({
  approval,
}: {
  approval: ReturnType<typeof useTransactionApproval>;
}) {
  if (!approval.isOpen) {
    if (!approval.signature) return null;
    return (
      <button className="transaction-status-reopen" onClick={approval.reopen}>
        {approval.confirmationState === "confirmed"
          ? "Transaction confirmed · View details"
          : approval.confirmationState === "failed"
            ? "Transaction failed · View details"
            : "Transaction status · Check again"}
      </button>
    );
  }
  if (!approval.pending && !approval.signature && !approval.error) return null;
  const confirmed = approval.confirmationState === "confirmed";
  const submitted = approval.confirmationState === "confirming" ||
    approval.confirmationState === "unknown";
  const failed = approval.confirmationState === "failed";
  const walletAddress = approval.walletAddress;

  return (
    <div className="dialog-scrim" role="presentation">
      <section
        className="transaction-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transaction-title"
      >
        <button className="dialog-close" onClick={approval.close} aria-label="Close dialog">
          ×
        </button>
        <p className="eyebrow">
          {confirmed
            ? "CONFIRMED ON DEVNET"
            : submitted
              ? "SUBMITTED · CONFIRMATION PENDING"
              : failed
                ? "TRANSACTION FAILED"
                : "SOLANA DEVNET"}
        </p>
        <h2 id="transaction-title">
          {confirmed
            ? "Transaction confirmed."
            : submitted
              ? "Waiting for confirmation."
              : approval.pending?.title ?? "Could not continue"}
        </h2>
        {confirmed ? (
          <>
            <p className="dialog-copy">The transaction is confirmed on Solana Devnet.</p>
            <a
              className="explorer-link"
              href={`https://explorer.solana.com/tx/${approval.signature}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction on Solana Explorer ↗
            </a>
          </>
        ) : submitted ? (
          <>
            <p className="dialog-copy">
              The transaction was submitted but is not yet confirmed. HELD has not recorded this action as complete.
            </p>
            {approval.signature && (
              <a
                className="explorer-link"
                href={`https://explorer.solana.com/tx/${approval.signature}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
              >
                Check transaction on Solana Explorer ↗
              </a>
            )}
            {approval.error && <p className="transaction-error" role="alert">{approval.error}</p>}
            <button className="button-secondary full-width" onClick={approval.checkStatus} disabled={approval.isSending}>
              {approval.isSending ? "Checking status…" : "Check transaction status"}
            </button>
          </>
        ) : (
          <>
            {approval.pending && <p className="dialog-copy">{approval.pending.summary}</p>}
            {approval.isSimulating && (
              <p className="simulation-status">Simulating transaction before wallet approval…</p>
            )}
            {approval.pending && (
              <div className="transaction-summary">
                <div><span>Network</span><strong>Solana Devnet</strong></div>
                <div><span>Fee payer</span><strong>{walletAddress ? `${walletAddress.slice(0, 5)}…${walletAddress.slice(-5)}` : "Wallet"}</strong></div>
                <div>
                  <span>Simulation</span>
                  <strong className="simulation-passed">
                    Passed{approval.pending.unitsConsumed == null ? "" : ` · ${approval.pending.unitsConsumed.toLocaleString()} CU`}
                  </strong>
                </div>
              </div>
            )}
            {approval.error && (
              <p className="transaction-error" role="alert">{approval.error}</p>
            )}
            {approval.pending && (
              <button
                className="button-primary full-width"
                onClick={approval.approve}
                disabled={approval.isSending || approval.isSimulating}
              >
                {approval.isSending ? "Waiting for confirmation…" : "Approve in wallet"}
                <span>→</span>
              </button>
            )}
            {!approval.pending && (
              <button className="button-secondary" onClick={approval.close}>Close</button>
            )}
            {approval.pending && (
              <button className="dialog-cancel" onClick={approval.close} disabled={approval.isSending}>
                Cancel
              </button>
            )}
            <p className="fine-print">
              Review the transaction in your wallet. HELD never requests a recovery phrase.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
