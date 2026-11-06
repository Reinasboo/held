import { getProgramAddress } from "@/lib/held-program";
import type { Address } from "@solana/kit";
import { getSolanaRpcUrl } from "@/lib/server/runtime";

type JsonRecord = Record<string, unknown>;

export class InvalidReservationProofError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.pubkey === "string") return value.pubkey;
  return null;
}

export async function verifyConfirmedReservationTransaction(input: {
  signature: string;
  event: Address;
  registration: Address;
  attendee: Address;
}): Promise<void> {
  const response = await fetch(getSolanaRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "held-notification-subscription",
      method: "getTransaction",
      params: [
        input.signature,
        {
          commitment: "confirmed",
          encoding: "json",
          maxSupportedTransactionVersion: 1,
        },
      ],
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Solana RPC rejected transaction verification (${response.status}).`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Solana RPC returned an invalid response.");
  if (payload.error) {
    throw new InvalidReservationProofError("Solana RPC could not verify the transaction.");
  }
  const result = payload.result;
  if (!isRecord(result)) {
    throw new InvalidReservationProofError(
      "The reservation transaction is not confirmed on Solana.",
    );
  }
  const transaction = result.transaction;
  const message = isRecord(transaction) ? transaction.message : null;
  const meta = result.meta;
  if (!isRecord(transaction) || !isRecord(message) || !isRecord(meta)) {
    throw new Error("Solana RPC returned incomplete transaction details.");
  }
  if (meta.err !== null) {
    throw new InvalidReservationProofError("The supplied reservation transaction failed.");
  }

  const signatures = transaction.signatures;
  if (
    !Array.isArray(signatures) ||
    signatures[0] !== input.signature
  ) {
    throw new InvalidReservationProofError(
      "The supplied signature does not match the confirmed transaction.",
    );
  }
  const rawKeys = message.accountKeys;
  const staticKeys = Array.isArray(rawKeys)
    ? rawKeys.map(accountKey).filter((key): key is string => key !== null)
    : [];
  const header = message.header;
  const requiredSignatures =
    isRecord(header) && typeof header.numRequiredSignatures === "number"
      ? header.numRequiredSignatures
      : 0;
  const signerKeys = staticKeys.slice(0, requiredSignatures);
  const loadedAddresses = isRecord(meta.loadedAddresses)
    ? [
        ...(Array.isArray(meta.loadedAddresses.writable)
          ? meta.loadedAddresses.writable.map(accountKey)
          : []),
        ...(Array.isArray(meta.loadedAddresses.readonly)
          ? meta.loadedAddresses.readonly.map(accountKey)
          : []),
      ].filter((key): key is string => key !== null)
    : [];
  const allKeys = new Set([...staticKeys, ...loadedAddresses]);
  if (
    !signerKeys.includes(input.attendee) ||
    !allKeys.has(input.registration) ||
    !allKeys.has(input.event) ||
    !allKeys.has(getProgramAddress())
  ) {
    throw new InvalidReservationProofError(
      "The transaction does not prove this attendee's reservation.",
    );
  }

  const logs = Array.isArray(meta.logMessages)
    ? meta.logMessages.filter((line): line is string => typeof line === "string")
    : [];
  if (
    !logs.some((line) => line.includes(`Program ${getProgramAddress()} invoke`)) ||
    !logs.some((line) => /Instruction:\s*(ReserveSeat|reserve_seat)/i.test(line))
  ) {
    throw new InvalidReservationProofError(
      "The supplied transaction is not a HELD reservation.",
    );
  }
}
