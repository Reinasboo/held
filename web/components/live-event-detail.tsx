"use client";

import type { Address } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useEffect, useState } from "react";
import type { AppClient } from "@/components/providers";
import { EventCoverImage } from "@/components/event-cover";
import {
  DEVNET_USDC_MINT,
  formatUsdc,
  getProgramAddress,
  loadEvent,
  reserveSeatInstructions,
} from "@/lib/held-program";
import {
  TransactionApprovalDialog,
  useTransactionApproval,
} from "@/components/use-transaction-approval";

function formatEventTime(timestamp: bigint, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(Number(timestamp) * 1000));
  } catch {
    return "Event time unavailable";
  }
}

function formatDeadline(timestamp: bigint, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(Number(timestamp) * 1000));
  } catch {
    return "Deadline unavailable";
  }
}

export function LiveEventDetail({
  eventAddress,
  onBack,
  onReservationConfirmed,
}: {
  eventAddress: string;
  onBack: () => void;
  onReservationConfirmed: () => void;
}) {
  const client = useClient<AppClient>();
  const wallet = useConnectedWallet(client);
  const approval = useTransactionApproval();
  const [loadResult, setLoadResult] = useState<
    | { address: string; event: Awaited<ReturnType<typeof loadEvent>> }
    | { address: string; error: string }
    | null
  >(null);
  const [termsAcceptedFor, setTermsAcceptedFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notificationEmail, setNotificationEmail] = useState("");
  const [notificationOptIn, setNotificationOptIn] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationProof, setNotificationProof] = useState<{
    attendee: string;
    event: string;
    registration: string;
    signature: string;
    email: string;
  } | null>(null);
  const [nowSeconds, setNowSeconds] = useState(0n);
  const [reservationConfirmed, setReservationConfirmed] = useState(false);

  useEffect(() => {
    let active = true;
    loadEvent(client, eventAddress)
      .then((loaded) => {
        if (active) setLoadResult({ address: eventAddress, event: loaded });
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadResult({
            address: eventAddress,
            error: reason instanceof Error ? reason.message : "Could not load this event.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [client, eventAddress]);

  useEffect(() => {
    const updateTime = () => setNowSeconds(BigInt(Math.floor(Date.now() / 1000)));
    const initialUpdate = window.setTimeout(updateTime, 0);
    const interval = window.setInterval(updateTime, 30_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(interval);
    };
  }, []);

  const result = loadResult?.address === eventAddress ? loadResult : null;
  const event = result && "event" in result ? result.event : null;
  const loadError = result && "error" in result ? result.error : null;
  const isLoading = result === null;

  async function sendNotificationVerification(proof: NonNullable<typeof notificationProof>) {
    setNotificationError(null);
    setNotificationMessage(null);
    try {
      const response = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proof),
      });
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Could not enable email notifications.");
      }
      setNotificationMessage(
        result.message ?? "Check your inbox to verify email notifications.",
      );
    } catch (reason) {
      setNotificationError(
        reason instanceof Error
          ? reason.message
          : "Could not enable email notifications.",
      );
    }
  }

  async function reserve() {
    if (!event) return;
    setActionError(null);
    if (!wallet) {
      setActionError("Connect your Solana Devnet wallet to reserve a place.");
      return;
    }
    if (termsAcceptedFor !== event.address) {
      setActionError("Review and accept the event terms before continuing.");
      return;
    }
    if (
      notificationOptIn &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail.trim())
    ) {
      setActionError("Enter a valid email address to enable event notifications.");
      return;
    }
    try {
      const { instructions, registrationAddress } = await reserveSeatInstructions(
        client,
        getProgramAddress(),
        event,
        wallet.account.address as Address,
      );
      await approval.prepare(
        "Reserve this place?",
        `${formatUsdc(event.depositAmount)} USDC will be held in this registration's escrow. It will be refunded after authorized check-in, organizer cancellation, or cancellation by ${formatDeadline(event.cancellationDeadline, event.timeZone)}. If you miss the event, you forfeit the deposit to the organizer unless the organizer chooses to refund you.`,
        instructions,
        (signature) => {
          setReservationConfirmed(true);
          onReservationConfirmed();
          if (notificationOptIn) {
            const proof = {
                attendee: wallet.account.address,
                email: notificationEmail.trim(),
                event: event.address,
                registration: registrationAddress,
                signature,
              };
            setNotificationProof(proof);
            void sendNotificationVerification(proof);
          }
        },
      );
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Could not prepare the reservation.",
      );
    }
  }

  const supportedMint = event?.mint === DEVNET_USDC_MINT;
  const registrationOpen =
    event !== null &&
    event.status === "active" &&
    nowSeconds >= event.registrationOpenAt &&
    nowSeconds <= event.registrationCloseAt &&
    event.reservedCount < event.capacity;
  const registrationMessage =
    event === null
      ? null
      : event.status !== "active"
        ? "This event has been cancelled."
        : event.reservedCount >= event.capacity
          ? "This event is full."
          : nowSeconds < event.registrationOpenAt
            ? `Registration opens ${formatDeadline(event.registrationOpenAt, event.timeZone)}.`
            : nowSeconds > event.registrationCloseAt
              ? "Registration has closed."
              : null;

  return (
    <section className="detail-layout" aria-labelledby="event-title">
      <button className="text-back" onClick={onBack}>← All events</button>
      {isLoading && <div className="state-panel">Loading verified event details from Solana Devnet…</div>}
      {loadError && <p className="transaction-error" role="alert">{loadError}</p>}
      {event && (
        <div className="detail-grid">
          <div>
            <div className="event-art detail-art">
              <EventCoverImage eventAddress={event.address} />
              <div className="art-shape art-shape-one" />
              <div className="art-shape art-shape-two" />
              <span className="event-art-label">A PLACE, HELD</span>
              <span className="event-art-mark">held.</span>
            </div>
            <div className="detail-copy">
              <span className="category">ON-CHAIN EVENT</span>
              <h1 id="event-title">{event.name}</h1>
              <p>{event.description}</p>
              <h2>{event.location}</h2>
              <p className="event-address">
                Event account{" "}
                <a
                  href={`https://explorer.solana.com/address/${event.address}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {event.address.slice(0, 7)}…{event.address.slice(-7)} ↗
                </a>
              </p>
            </div>
          </div>
          <aside className="reservation-panel">
            <p className="eyebrow">YOUR PLACE, HELD</p>
            <h2>Everything, up front.</h2>
            <div className="policy-list">
              <div>
                <span>◷</span>
                <p><strong>{formatEventTime(event.eventStartAt, event.timeZone)}</strong><br />Event time zone: {event.timeZone}</p>
              </div>
              <div>
                <span>⌖</span>
                <p><strong>{event.location}</strong><br />Organizer wallet: {event.organizer.slice(0, 6)}…{event.organizer.slice(-6)}</p>
              </div>
              <div>
                <span>↗</span>
                <p><strong>{formatUsdc(event.depositAmount)} USDC commitment</strong><br />Full refund after authorized check-in</p>
              </div>
              <div>
                <span>✓</span>
                <p><strong>Cancel by {formatDeadline(event.cancellationDeadline, event.timeZone)}</strong><br />Full refund before the deadline</p>
              </div>
              <div>
                <span>◎</span>
                <p><strong>Check-in window</strong><br />{formatDeadline(event.checkInStartAt, event.timeZone)} – {formatDeadline(event.checkInEndAt, event.timeZone)}</p>
              </div>
              <div>
                <span>!</span>
                <p><strong>Missed event: deposit goes to the organizer</strong><br />If you miss the event, your deposit is forfeited to the organizer. The organizer may choose to issue you a full refund instead.</p>
              </div>
            </div>
            <div className="policy-note">
              Your deposit is not an admission fee. Organizer cancellation always allows a full refund. HELD records an authorized organizer check-in; it does not independently prove physical attendance.
            </div>
            {!supportedMint && (
              <p className="configuration-note">
                This event uses an unsupported token mint. Do not send funds.
              </p>
            )}
            {event.status !== "active" && (
              <p className="configuration-note">{registrationMessage} Eligible attendees may claim a full refund.</p>
            )}
            {event.status === "active" && registrationMessage && (
              <p className="configuration-note">{registrationMessage}</p>
            )}
            <label className="terms-check">
              <input
                type="checkbox"
                checked={termsAcceptedFor === event.address}
                onChange={(change) => setTermsAcceptedFor(change.target.checked ? event.address : null)}
              />
              <span>I understand the deposit, cancellation deadline, check-in, and no-show forfeiture policy.</span>
            </label>
            <label className="form-field notification-email">
              Email for optional event updates
              <input
                type="email"
                autoComplete="email"
                value={notificationEmail}
                onChange={(change) => setNotificationEmail(change.target.value)}
                placeholder="you@example.com"
                disabled={reservationConfirmed}
              />
            </label>
            <label className="terms-check">
              <input
                type="checkbox"
                checked={notificationOptIn}
                onChange={(change) => setNotificationOptIn(change.target.checked)}
                disabled={reservationConfirmed || !notificationEmail.trim()}
              />
              <span>Send me reservation, event, attendance, and refund updates. I’ll verify this address by email.</span>
            </label>
            <button
              className="button-primary full-width"
              onClick={reserve}
              disabled={
                !supportedMint ||
                !registrationOpen ||
                reservationConfirmed ||
                termsAcceptedFor !== event.address ||
                approval.isSimulating ||
                approval.isSending
              }
            >
              {reservationConfirmed
                ? "Reservation confirmed"
                : approval.isSimulating
                  ? "Checking transaction…"
                  : "Reserve my place"}
              <span>→</span>
            </button>
            {actionError && <p className="inline-error" role="alert">{actionError}</p>}
            {notificationMessage && <p className="configuration-note" role="status">{notificationMessage}</p>}
            {notificationError && <p className="transaction-error" role="alert">{notificationError}</p>}
            {notificationError && notificationProof && (
              <button
                className="button-secondary"
                onClick={() => void sendNotificationVerification(notificationProof)}
              >
                Retry verification email
              </button>
            )}
            <p className="fine-print">
              The wallet will show the transaction. HELD simulates it first and only submits after your approval.
            </p>
          </aside>
        </div>
      )}
      <TransactionApprovalDialog approval={approval} />
    </section>
  );
}
