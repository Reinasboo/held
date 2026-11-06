"use client";

import type { Address } from "@solana/kit";
import { QRCodeSVG } from "qrcode.react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useEffect, useState } from "react";
import type { AppClient } from "@/components/providers";
import {
  cancelRegistrationInstruction,
  formatUsdc,
  getProgramAddress,
  isHeldConfigured,
  loadEvent,
  loadRegistrationHistory,
  loadRegistrations,
  refundInstruction,
  type EventAccount,
  type RegistrationAccount,
} from "@/lib/held-program";
import {
  TransactionApprovalDialog,
  useTransactionApproval,
} from "@/components/use-transaction-approval";

type Reservation = {
  registration: RegistrationAccount;
  event: EventAccount;
  history: Awaited<ReturnType<typeof loadRegistrationHistory>>;
  historyError: string | null;
};

function statusLabel(registration: RegistrationAccount) {
  if (registration.settlementStatus === "paid_to_organizer") return "NO-SHOW · PAID TO ORGANIZER";
  if (registration.settlementStatus === "refunded") return "REFUNDED";
  if (registration.attendanceStatus === "checked_in") return "ATTENDED · REFUND PENDING";
  if (registration.attendanceStatus === "no_show_pending" || registration.attendanceStatus === "disputed") return "NO-SHOW · ORGANIZER DECISION";
  if (registration.reservationStatus === "cancelled") return "CANCELLED";
  return "PLACE CONFIRMED";
}

export function ReservationsView({
  onReservationUpdated,
}: {
  onReservationUpdated: () => void;
}) {
  const client = useClient<AppClient>();
  const wallet = useConnectedWallet(client);
  const approval = useTransactionApproval();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loadedWalletAddress, setLoadedWalletAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(0n);
  const configured = isHeldConfigured();

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        const shouldLoad = Boolean(wallet && configured);
        setLoading(shouldLoad);
        if (!shouldLoad || !wallet) return [];
        setError(null);
        return loadRegistrations(client, wallet.account.address as Address).then((registrations) =>
          Promise.all(
            registrations.map(async (registration) => {
              const [event, historyResult] = await Promise.all([
                loadEvent(client, registration.event),
                loadRegistrationHistory(client, registration.address)
                  .then((history) => ({ history, error: null }))
                  .catch((reason: unknown) => ({
                    history: [],
                    error:
                      reason instanceof Error
                        ? reason.message
                        : "Could not load transaction history.",
                  })),
              ]);
              return {
                registration,
                event,
                history: historyResult.history,
                historyError: historyResult.error,
              };
            }),
          ),
        );
      })
      .then((result) => {
        if (active) {
          setReservations(result);
          setLoadedWalletAddress(wallet?.account.address ?? null);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadedWalletAddress(wallet?.account.address ?? null);
          setError(
            reason instanceof Error ? reason.message : "Could not load reservations.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, configured, refreshKey, wallet]);

  useEffect(() => {
    const updateTime = () => setNowSeconds(BigInt(Math.floor(Date.now() / 1000)));
    const initialUpdate = window.setTimeout(updateTime, 0);
    const interval = window.setInterval(updateTime, 30_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(interval);
    };
  }, []);

  function refresh() {
    setRefreshKey((value) => value + 1);
    onReservationUpdated();
  }

  async function cancel(reservation: Pick<Reservation, "registration" | "event">) {
    if (!wallet) return;
    try {
      const instructions = await cancelRegistrationInstruction(
        getProgramAddress(),
        client,
        reservation.event,
        wallet.account.address as Address,
      );
      await approval.prepare(
        "Cancel and refund this reservation?",
        `${formatUsdc(reservation.registration.depositAmount)} USDC will be returned to your wallet. This is only available before ${new Date(Number(reservation.event.cancellationDeadline) * 1000).toLocaleString("en-US", { timeZone: reservation.event.timeZone, timeZoneName: "short" })}.`,
        instructions,
        refresh,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not prepare cancellation.",
      );
    }
  }

  async function claimRefund(reservation: Pick<Reservation, "registration" | "event">) {
    if (!wallet) return;
    try {
      const instruction = await refundInstruction(
        getProgramAddress(),
        client,
        reservation.event,
        reservation.registration,
        wallet.account.address as Address,
      );
      await approval.prepare(
        "Claim your full refund?",
        `${formatUsdc(reservation.registration.depositAmount)} USDC will be transferred from this registration's escrow to your wallet.`,
        instruction,
        refresh,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not prepare your refund.",
      );
    }
  }

  return (
    <section className="reservations-layout">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">YOUR PLACES</p>
          <h1>Your plans, in one place.</h1>
          <p className="section-intro">Confirmed on-chain reservations, attendance passes, and refund status.</p>
        </div>
        <button className="refresh-button" onClick={refresh} disabled={loading}>↻ Refresh</button>
      </div>
      {!wallet && (
        <div className="empty-panel">
          <div className="empty-icon">◷</div>
          <h2>Connect your wallet to see your places.</h2>
          <p>Your dashboard is tied to the public address that created each reservation.</p>
        </div>
      )}
      {wallet && !configured && (
        <div className="configuration-note">
          Reservations are unavailable until a HELD Devnet program and verified USDC mint are configured.
        </div>
      )}
      {loading && wallet && configured && <div className="state-panel">Reading your reservation accounts from Solana Devnet…</div>}
      {error && wallet && configured && loadedWalletAddress === wallet.account.address && <p className="transaction-error" role="alert">{error}</p>}
      {wallet && configured && loadedWalletAddress === wallet.account.address && !loading && !error && reservations.length === 0 && (
        <div className="empty-panel">
          <div className="empty-icon">◷</div>
          <h2>Your next good thing starts here.</h2>
          <p>Your confirmed reservations, QR passes and refund status will live in one place.</p>
        </div>
      )}
      <div className="reservation-list">
        {(wallet && configured && loadedWalletAddress === wallet.account.address ? reservations : []).map(({ registration, event, history, historyError }) => {
          const canCancel =
            registration.reservationStatus === "confirmed" &&
            registration.attendanceStatus === "not_checked_in" &&
            registration.settlementStatus === "held" &&
            event.status === "active" &&
            nowSeconds <= event.cancellationDeadline;
          const canClaimRefund =
            registration.settlementStatus === "held" &&
            (event.status === "cancelled" ||
              registration.attendanceStatus === "checked_in");
          const qrPayload =
            `HELD1|${event.address}|${registration.attendee}|${registration.address}`;
          return (
            <article className="reservation-card" key={registration.address}>
              <div className="reservation-card-main">
                <div className="reservation-card-heading">
                  <div>
                    <span className="category">{statusLabel(registration)}</span>
                    <h2>{event.name}</h2>
                    <p>{event.location}</p>
                  </div>
                  <div className="reservation-amount">
                    <span>REFUNDABLE COMMITMENT</span>
                    <strong>{formatUsdc(registration.depositAmount)} <small>USDC</small></strong>
                  </div>
                </div>
                <div className="reservation-meta">
                  <span>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: event.timeZone }).format(new Date(Number(event.eventStartAt) * 1000))} · {event.timeZone}</span>
                  <span>{event.status === "cancelled" ? "Organizer cancelled" : `Cancel by ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: event.timeZone }).format(new Date(Number(event.cancellationDeadline) * 1000))}`}</span>
                  <a href={`https://explorer.solana.com/address/${registration.address}?cluster=devnet`} target="_blank" rel="noreferrer">Registration account ↗</a>
                </div>
                <section className="reservation-history" aria-label="Reservation transaction history">
                  <h3>On-chain transaction history</h3>
                  {historyError ? (
                    <p role="alert">Transaction history could not be loaded: {historyError}</p>
                  ) : history.length === 0 ? (
                    <p>No confirmed transactions were found for this registration account.</p>
                  ) : (
                    <ul>
                      {history.map((transaction) => (
                        <li key={transaction.signature}>
                          <span>{transaction.blockTime === null ? "Confirmed" : new Date(transaction.blockTime * 1000).toLocaleString("en-US")}</span>
                          <a
                            href={`https://explorer.solana.com/tx/${transaction.signature}?cluster=devnet`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {transaction.failed ? "Failed transaction" : "View transaction"} · {transaction.signature.slice(0, 8)}… ↗
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {(registration.attendanceStatus === "not_checked_in" &&
                  registration.reservationStatus === "confirmed" &&
                  registration.settlementStatus === "held" &&
                  event.status === "active") && (
                  <div className="pass-panel">
                    <div className="qr-frame">
                      <QRCodeSVG value={qrPayload} size={146} level="M" includeMargin />
                    </div>
                    <div>
                      <p className="eyebrow">YOUR ATTENDANCE PASS</p>
                      <h3>Show this at the door.</h3>
                      <p>The authorized organizer scans this pass. A valid check-in triggers your refund. The QR is event-specific and cannot move funds.</p>
                      <span className="registration-ref">{registration.address.slice(0, 8)}…{registration.address.slice(-8)}</span>
                    </div>
                  </div>
                )}
                <div className="reservation-actions">
                  {canCancel && (
                    <button className="button-secondary" onClick={() => cancel({ registration, event })}>
                      Cancel and get refund <span>↻</span>
                    </button>
                  )}
                  {canClaimRefund && (
                    <button className="button-primary" onClick={() => claimRefund({ registration, event })}>
                      Claim full refund <span>→</span>
                    </button>
                  )}
                  {registration.settlementStatus === "refunded" && (
                    <span className="refund-complete">✓ Full refund confirmed on-chain</span>
                  )}
                  {(registration.attendanceStatus === "no_show_pending" ||
                    registration.attendanceStatus === "disputed") && (
                    <p className="locked-note">
                      {registration.settlementStatus === "paid_to_organizer"
                        ? "The no-show deposit was paid to the event organizer."
                        : "The organizer recorded a no-show. They may either pay the deposit to themselves or choose to refund you."}
                    </p>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <TransactionApprovalDialog approval={approval} />
    </section>
  );
}
