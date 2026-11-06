"use client";

import type { Address } from "@solana/kit";
import { BrowserQRCodeReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AppClient } from "@/components/providers";
import { EventCoverUpload } from "@/components/event-cover";
import { OrganizerLiveUpdates } from "@/components/organizer-live-updates";
import {
  cancelEventInstruction,
  checkInInstruction,
  createEventInstruction,
  finalizeNoShowInstruction,
  formatUsdc,
  getProgramAddress,
  isHeldConfigured,
  loadEventRegistrations,
  loadRegistrationHistory,
  parseCredential,
  refundNoShowInstruction,
  withdrawEligibleFundsInstructions,
  type EventAccount,
  type NewEventInput,
  type RegistrationAccount,
} from "@/lib/held-program";
import {
  TransactionApprovalDialog,
  useTransactionApproval,
} from "@/components/use-transaction-approval";

type ManagedEvent = {
  event: EventAccount;
  registrations: RegistrationAccount[];
};

type SettlementReportEntry = {
  registration: RegistrationAccount;
  transactions: Awaited<ReturnType<typeof loadRegistrationHistory>>;
};

function settlementTotal(
  registrations: RegistrationAccount[],
  status: RegistrationAccount["settlementStatus"],
): bigint {
  return registrations
    .filter((registration) => registration.settlementStatus === status)
    .reduce((total, registration) => total + registration.depositAmount, 0n);
}

function parseUsdc(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) {
    throw new Error("Enter a positive USDC amount with up to 6 decimal places.");
  }
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  const amount = whole * 1_000_000n + fraction;
  if (amount <= 0n) throw new Error("The USDC commitment must be greater than zero.");
  return amount;
}

function toTimestamp(value: FormDataEntryValue | null): bigint {
  if (typeof value !== "string" || !value) {
    throw new Error("Complete all event date and time fields.");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Enter a valid event date and time.");
  return BigInt(Math.floor(milliseconds / 1000));
}

function useManagedEvents(
  events: EventAccount[],
  organizer: Address | undefined,
  client: AppClient,
  refreshKey: number,
) {
  const [managed, setManaged] = useState<ManagedEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        setLoading(true);
        if (!organizer || !isHeldConfigured()) return [];
        const ownedEvents = events.filter((event) => event.organizer === organizer);
        return Promise.all(
          ownedEvents.map(async (event) => ({
            event,
            registrations: await loadEventRegistrations(client, event.address),
          })),
        );
      })
      .then((result) => {
        if (active) {
          setManaged(result);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : "Could not load organizer data.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, events, organizer, refreshKey]);

  return { managed, error, loading };
}

function QrScanner({
  onDetected,
  onError,
}: {
  onDetected: (value: string) => void;
  onError: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const callbacks = useRef({ onDetected, onError });
  const [active, setActive] = useState(false);

  useEffect(() => {
    callbacks.current = { onDetected, onError };
  }, [onDetected, onError]);

  useEffect(() => {
    if (!active || !video.current) return;
    let cancelled = false;
    const reader = new BrowserQRCodeReader();
    reader
      .decodeFromVideoDevice(undefined, video.current, (result) => {
        if (result && !cancelled) {
          callbacks.current.onDetected(result.getText());
          setActive(false);
        }
      })
      .then((scannerControls) => {
        if (cancelled) scannerControls.stop();
        else controls.current = scannerControls;
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          callbacks.current.onError(
            reason instanceof Error
              ? reason.message
              : "Camera access was unavailable. Paste the QR pass instead.",
          );
          setActive(false);
        }
      });
    return () => {
      cancelled = true;
      controls.current?.stop();
      controls.current = null;
    };
  }, [active]);

  return (
    <div className="scanner-panel">
      {active ? (
        <video ref={video} className="scanner-video" muted playsInline />
      ) : (
        <button
          className="button-secondary"
          onClick={() => setActive(true)}
          type="button"
        >
          Open camera <span>◎</span>
        </button>
      )}
      <p className="fine-print">
        Camera access starts only after you select Open camera. A scanned pass does not check anyone in until you review the transaction.
      </p>
    </div>
  );
}

export function OrganizerView({
  events,
  configured,
  onEventOpen,
  onEventsChanged,
}: {
  events: EventAccount[];
  configured: boolean;
  onEventOpen: (eventAddress: string) => void;
  onEventsChanged: () => void;
}) {
  const client = useClient<AppClient>();
  const wallet = useConnectedWallet(client);
  const approval = useTransactionApproval();
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<EventAccount | null>(null);
  const [credential, setCredential] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(0n);
  const [createdEventAddress, setCreatedEventAddress] = useState<Address | null>(
    null,
  );
  const [linkCopied, setLinkCopied] = useState(false);
  const [settlementReports, setSettlementReports] = useState<
    Record<string, SettlementReportEntry[]>
  >({});
  const [reportLoadingEvent, setReportLoadingEvent] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const { managed, error: dataError, loading } = useManagedEvents(
    events,
    wallet?.account.address as Address | undefined,
    client,
    refreshKey,
  );

  const refresh = () => {
    setRefreshKey((value) => value + 1);
    setSettlementReports({});
    setReportError(null);
    onEventsChanged();
  };

  async function loadSettlementReport(
    event: EventAccount,
    registrations: RegistrationAccount[],
  ) {
    setReportLoadingEvent(event.address);
    setReportError(null);
    try {
      const entries: SettlementReportEntry[] = [];
      for (let offset = 0; offset < registrations.length; offset += 8) {
        const batch = registrations.slice(offset, offset + 8);
        entries.push(
          ...(await Promise.all(
            batch.map(async (registration) => ({
              registration,
              transactions: await loadRegistrationHistory(
                client,
                registration.address,
              ),
            })),
          )),
        );
      }
      setSettlementReports((current) => ({
        ...current,
        [event.address]: entries,
      }));
    } catch (reason) {
      setReportError(
        reason instanceof Error
          ? reason.message
          : "Could not load the settlement report from Devnet.",
      );
    } finally {
      setReportLoadingEvent(null);
    }
  }

  useEffect(() => {
    const updateTime = () => setNowSeconds(BigInt(Math.floor(Date.now() / 1000)));
    const initialUpdate = window.setTimeout(updateTime, 0);
    const interval = window.setInterval(updateTime, 30_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(interval);
    };
  }, []);

  async function createEvent(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    setFormError(null);
    if (!wallet) {
      setFormError("Connect your Solana Devnet wallet to create an event.");
      return;
    }
    try {
      const form = new FormData(submission.currentTarget);
      const start = toTimestamp(form.get("eventStartAt"));
      const input: NewEventInput = {
        name: String(form.get("name") ?? "").trim(),
        description: String(form.get("description") ?? "").trim(),
        location: String(form.get("location") ?? "").trim(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        eventStartAt: start,
        depositAmount: parseUsdc(String(form.get("depositAmount") ?? "")),
        capacity: Number(form.get("capacity")),
        registrationOpenAt: toTimestamp(form.get("registrationOpenAt")),
        registrationCloseAt: toTimestamp(form.get("registrationCloseAt")),
        cancellationDeadline: toTimestamp(form.get("cancellationDeadline")),
        checkInStartAt: toTimestamp(form.get("checkInStartAt")),
        checkInEndAt: toTimestamp(form.get("checkInEndAt")),
      };
      const { instruction, eventAddress } = await createEventInstruction(
        client,
        getProgramAddress(),
        wallet.account.address as Address,
        input,
      );
      await approval.prepare(
        "Publish this event?",
        `Create "${input.name}" on Solana Devnet. The event will accept ${formatUsdc(input.depositAmount)} USDC per reservation, with ${input.capacity} places. Attendees who miss the event forfeit the deposit to the organizer unless the organizer chooses to refund them. Fee payer: your connected wallet.`,
        [instruction],
        () => {
          setCreatedEventAddress(eventAddress);
          refresh();
        },
      );
    } catch (reason) {
      setFormError(
        reason instanceof Error ? reason.message : "Could not prepare this event.",
      );
    }
  }

  async function cancelEvent(event: EventAccount) {
    if (!wallet) {
      setManagementError("Connect the event organizer wallet to cancel this event.");
      return;
    }
    setManagementError(null);
    try {
      await approval.prepare(
        "Cancel this event?",
        `Cancel "${event.name}". Every held attendee deposit, including a pending no-show, becomes eligible for a full refund claim. No-show settlement to the organizer is disabled for cancelled events.`,
        [
          cancelEventInstruction(
            getProgramAddress(),
            event,
            wallet.account.address as Address,
          ),
        ],
        refresh,
      );
    } catch (reason) {
      setManagementError(
        reason instanceof Error ? reason.message : "Could not prepare event cancellation.",
      );
    }
  }

  async function refundNoShow(event: EventAccount, registration: RegistrationAccount) {
    if (!wallet) {
      setManagementError("Connect the event organizer wallet to refund this no-show.");
      return;
    }
    setManagementError(null);
    try {
      const instruction = await refundNoShowInstruction(
        getProgramAddress(),
        client,
        event,
        registration,
        wallet.account.address as Address,
      );
      await approval.prepare(
        "Refund this no-show?",
        `${formatUsdc(registration.depositAmount)} USDC will be returned to the attendee. This organizer-authorized refund is final.`,
        instruction,
        refresh,
      );
    } catch (reason) {
      setManagementError(
        reason instanceof Error ? reason.message : "Could not prepare the no-show refund.",
      );
    }
  }

  async function finalizeNoShow(event: EventAccount, registration: RegistrationAccount) {
    if (!wallet) {
      setManagementError("Connect an organizer wallet to record the no-show.");
      return;
    }
    setManagementError(null);
    try {
      const instruction = finalizeNoShowInstruction(
        getProgramAddress(),
        event,
        wallet.account.address as Address,
        registration,
      );
      await approval.prepare(
        "Record this no-show?",
        `Record the attendee as not checked in after the event's check-in window. The attendee's ${formatUsdc(registration.depositAmount)} USDC deposit will be forfeited to you unless you choose to refund it.`,
        [instruction],
        refresh,
      );
    } catch (reason) {
      setManagementError(
        reason instanceof Error ? reason.message : "Could not prepare the no-show record.",
      );
    }
  }

  async function settleNoShow(event: EventAccount, registration: RegistrationAccount) {
    if (!wallet) {
      setManagementError("Connect the event organizer wallet to settle this no-show.");
      return;
    }
    setManagementError(null);
    try {
      const instructions = await withdrawEligibleFundsInstructions(
        client,
        getProgramAddress(),
        event,
        wallet.account.address as Address,
        registration,
      );
      await approval.prepare(
        "Pay no-show deposit to the organizer?",
        `${formatUsdc(registration.depositAmount)} USDC will be transferred from this registration's escrow to you. This settlement is final.`,
        instructions,
        refresh,
      );
    } catch (reason) {
      setManagementError(
        reason instanceof Error ? reason.message : "Could not prepare no-show settlement.",
      );
    }
  }

  async function checkIn(event: EventAccount) {
    if (!wallet) {
      setScanError("Connect the organizer wallet to check in attendees.");
      return;
    }
    setScanError(null);
    try {
      const pass = parseCredential(credential.trim());
      const registration = managed
        .find((entry) => entry.event.address === event.address)
        ?.registrations.find((entry) => entry.address === pass.registration);
      if (!registration || registration.attendee !== pass.attendee) {
        throw new Error("This pass does not match an active registration for this event.");
      }
      if (
        registration.attendanceStatus !== "not_checked_in" ||
        registration.settlementStatus !== "held" ||
        registration.reservationStatus !== "confirmed"
      ) {
        throw new Error("This registration is not eligible for check-in.");
      }
      const instruction = await checkInInstruction(
        getProgramAddress(),
        event,
        wallet.account.address as Address,
        credential.trim(),
      );
      await approval.prepare(
        "Check in this attendee?",
        `Record the organizer's attendance attestation for wallet ${pass.attendee.slice(0, 7)}…${pass.attendee.slice(-7)}. A successful check-in makes the attendee's exact deposit refundable.`,
        [instruction],
        () => {
          setCredential("");
          refresh();
        },
      );
    } catch (reason) {
      setScanError(
        reason instanceof Error ? reason.message : "Could not validate this pass.",
      );
    }
  }

  async function copyEventLink(eventAddress: Address) {
    const link = `${window.location.origin}/?event=${eventAddress}`;
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      setFormError("Clipboard access failed. Copy the event link from the browser address bar.");
    }
  }

  return (
    <section className="organizer-layout">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FOR PEOPLE WHO BRING PEOPLE TOGETHER</p>
          <h1>Make a place<br />worth showing up for.</h1>
          <p className="section-intro">
            Publish a commitment link alongside your existing event page. No migration, no new ticketing platform.
          </p>
        </div>
        <div className="organizer-aside">
          <div className="organizer-aside-number">01</div>
          <p>Set the terms.<br />Keep your event tools.</p>
        </div>
      </div>
      <div className="organizer-grid">
        <div className="organizer-feature"><span>↗</span><h3>Your event, your rules.</h3><p>Choose capacity, a modest refundable deposit, a cancellation window and clear check-in terms.</p></div>
        <div className="organizer-feature"><span>◎</span><h3>A reliable signal.</h3><p>Confirmed commitments give you a better sense of the people who plan to be there.</p></div>
        <div className="organizer-feature"><span>↻</span><h3>Fair from both sides.</h3><p>Attendees see every term up front. Show up or cancel on time and their money comes back.</p></div>
      </div>

      <section className="organizer-form-panel">
        <div className="form-heading">
          <div>
            <p className="eyebrow">CREATE A DEVNET EVENT</p>
            <h2>Start with the terms.</h2>
          </div>
          <span className="network-pill">SOLANA DEVNET</span>
        </div>
        {!configured && (
          <p className="configuration-note">
            Publishing is disabled until a deployed HELD program and verified Devnet USDC mint are configured.
          </p>
        )}
        {!wallet && configured && (
          <p className="configuration-note">Connect the organizer wallet before publishing.</p>
        )}
        <form className="event-form" onSubmit={createEvent}>
          <label className="form-field">
            Event name
            <input name="name" maxLength={96} required placeholder="e.g. Build together, better" />
          </label>
          <label className="form-field">
            Location
            <input name="location" maxLength={160} required placeholder="Venue, city or online" />
          </label>
          <label className="form-field form-span">
            Description
            <textarea name="description" maxLength={512} rows={3} placeholder="What should attendees know?" />
          </label>
          <label className="form-field">
            Event date and time
            <input name="eventStartAt" type="datetime-local" required />
            <small>Dates are entered in your browser&apos;s local time zone.</small>
          </label>
          <label className="form-field">
            Registration opens
            <input name="registrationOpenAt" type="datetime-local" required />
          </label>
          <label className="form-field">
            Registration closes
            <input name="registrationCloseAt" type="datetime-local" required />
          </label>
          <label className="form-field">
            Cancellation deadline
            <input name="cancellationDeadline" type="datetime-local" required />
          </label>
          <label className="form-field">
            Check-in opens
            <input name="checkInStartAt" type="datetime-local" required />
          </label>
          <label className="form-field">
            Check-in closes
            <input name="checkInEndAt" type="datetime-local" required />
          </label>
          <label className="form-field">
            Places available
            <input name="capacity" type="number" min={1} max={100000} required placeholder="100" />
          </label>
          <label className="form-field">
            Refundable deposit (USDC)
            <input name="depositAmount" type="number" min="0.01" max="1000" step="0.01" required placeholder="5.00" />
          </label>
          <div className="no-show-disclosure form-span">
            <strong>No-show policy</strong>
            <p>An attendee who misses the event forfeits the deposit to the organizer. After recording a no-show, the organizer may either claim the deposit or choose to refund the attendee. Cancelling the event keeps all held deposits refundable.</p>
          </div>
          {formError && <p className="transaction-error form-span" role="alert">{formError}</p>}
          <div className="form-actions form-span">
            <button className="button-primary" type="submit" disabled={!configured || !wallet || approval.isSimulating}>
              {approval.isSimulating ? "Simulating event creation…" : "Review and publish"}
              <span>→</span>
            </button>
            <p className="fine-print">Event text, terms and organizer wallet are stored in the public on-chain account.</p>
          </div>
        </form>
      </section>

      {createdEventAddress && (
        <div className="created-event-banner">
          <div>
            <p className="eyebrow">EVENT CREATED ON DEVNET</p>
            <p>Share this event link with attendees.</p>
          </div>
          <button className="button-secondary" onClick={() => copyEventLink(createdEventAddress)}>
            {linkCopied ? "Copied" : "Copy event link"} <span>↗</span>
          </button>
          <button
            className="text-link"
            onClick={() => onEventOpen(createdEventAddress)}
          >
            View event
          </button>
        </div>
      )}

      <section className="managed-events">
        <div className="form-heading">
          <div><p className="eyebrow">YOUR EVENTS</p><h2>Commitments at a glance.</h2></div>
          <button className="refresh-button" onClick={refresh} disabled={loading}>↻ Refresh</button>
        </div>
        {!wallet && <p className="empty-inline">Connect the organizer wallet to see its events.</p>}
        {loading && <p className="empty-inline">Loading event and registration accounts from Devnet…</p>}
        {dataError && <p className="transaction-error" role="alert">{dataError}</p>}
        {wallet && !loading && !dataError && managed.length === 0 && (
          <p className="empty-inline">No HELD events have been created by this wallet.</p>
        )}
        {managementError && <p className="transaction-error" role="alert">{managementError}</p>}
        {wallet && process.env.NEXT_PUBLIC_NEON_REALTIME_URL ? (
          <OrganizerLiveUpdates
            organizer={wallet.account.address as Address}
            onUpdate={refresh}
          />
        ) : wallet ? (
          <p className="realtime-status" role="status">
            Live updates are unavailable because NEXT_PUBLIC_NEON_REALTIME_URL is not configured.
          </p>
        ) : null}
        <div className="managed-list">
          {managed.map(({ event, registrations }) => (
            <article className="managed-event" key={event.address}>
              {wallet && (
                <EventCoverUpload
                  event={event}
                  organizer={wallet.account.address as Address}
                  onUploaded={refresh}
                />
              )}
              <div className="managed-event-top">
                <div>
                  <span className="category">{event.status === "active" ? "ACTIVE EVENT" : "CANCELLED EVENT"}</span>
                  <h3>{event.name}</h3>
                  <p>{event.location} · {event.timeZone}</p>
                </div>
                <a
                  className="explorer-link"
                  href={`https://explorer.solana.com/address/${event.address}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  On-chain account ↗
                </a>
              </div>
              <div className="organizer-stats">
                <div><span>Reservations</span><strong>{event.reservedCount} / {event.capacity}</strong></div>
                <div><span>Checked in</span><strong>{registrations.filter((item) => item.attendanceStatus === "checked_in").length}</strong></div>
                <div><span>Held in escrow</span><strong>{formatUsdc(event.heldAmount)} USDC</strong></div>
                <div><span>Refunded</span><strong>{registrations.filter((item) => item.settlementStatus === "refunded").length}</strong></div>
                <div><span>Refunded volume</span><strong>{formatUsdc(settlementTotal(registrations, "refunded"))} USDC</strong></div>
                <div><span>Paid to organizer</span><strong>{registrations.filter((item) => item.settlementStatus === "paid_to_organizer").length}</strong></div>
                <div><span>Organizer payout</span><strong>{formatUsdc(settlementTotal(registrations, "paid_to_organizer"))} USDC</strong></div>
                <div><span>No-show decisions</span><strong>{registrations.filter((item) => (item.attendanceStatus === "no_show_pending" || item.attendanceStatus === "disputed") && item.settlementStatus === "held").length}</strong></div>
              </div>
              <div className="managed-actions">
                <button className="button-secondary" onClick={() => setSelectedEvent(event)} disabled={event.status !== "active"}>
                  Open check-in <span>◎</span>
                </button>
                <button className="text-link" onClick={() => onEventOpen(event.address)}>View public event ↗</button>
                {event.status === "active" && (
                  <button className="cancel-event-button" onClick={() => cancelEvent(event)}>
                    Cancel event
                  </button>
                )}
              </div>
              <section className="settlement-report" aria-label={`${event.name} settlement report`}>
                <div className="settlement-row">
                  <div>
                    <p className="eyebrow">SETTLEMENT REPORT</p>
                    <p>Current states come from Devnet; links open the related registration and recent transactions.</p>
                  </div>
                  <button
                    className="button-secondary"
                    onClick={() => loadSettlementReport(event, registrations)}
                    disabled={reportLoadingEvent === event.address}
                  >
                    {reportLoadingEvent === event.address
                      ? "Loading report…"
                      : settlementReports[event.address]
                        ? "Refresh report"
                        : "Load report"}
                  </button>
                </div>
                {reportError && (
                  <p className="transaction-error" role="alert">{reportError}</p>
                )}
                {settlementReports[event.address]?.map(({ registration, transactions }) => (
                  <div className="settlement-row" key={registration.address}>
                    <span>
                      {registration.attendee.slice(0, 7)}…{registration.attendee.slice(-7)} ·{" "}
                      {formatUsdc(registration.depositAmount)} USDC ·{" "}
                      {registration.settlementStatus.replaceAll("_", " ")} /{" "}
                      {registration.attendanceStatus.replaceAll("_", " ")}
                    </span>
                    <a
                      className="explorer-link"
                      href={`https://explorer.solana.com/address/${registration.address}?cluster=devnet`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Account ↗
                    </a>
                    {transactions.map((transaction) => (
                      <a
                        className="explorer-link"
                        href={`https://explorer.solana.com/tx/${transaction.signature}?cluster=devnet`}
                        key={transaction.signature}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {transaction.failed ? "Failed" : "Transaction"}{" "}
                        {transaction.signature.slice(0, 8)}… ↗
                      </a>
                    ))}
                    {transactions.length === 0 && <span>No transactions found</span>}
                  </div>
                ))}
              </section>
              {event.status === "active" &&
                nowSeconds > event.checkInEndAt &&
                registrations.some((item) =>
                  item.reservationStatus === "confirmed" &&
                  item.attendanceStatus === "not_checked_in" &&
                  item.settlementStatus === "held",
                ) && (
                  <div className="no-show-list">
                    <p className="eyebrow">CHECK-IN WINDOW CLOSED · RECORD MISSED ATTENDEES</p>
                    {registrations
                      .filter((item) =>
                        item.reservationStatus === "confirmed" &&
                        item.attendanceStatus === "not_checked_in" &&
                        item.settlementStatus === "held",
                      )
                      .map((registration) => (
                        <div className="settlement-row" key={registration.address}>
                          <span>{registration.attendee.slice(0, 7)}…{registration.attendee.slice(-7)} · {formatUsdc(registration.depositAmount)} USDC</span>
                          <button className="button-secondary" onClick={() => finalizeNoShow(event, registration)}>Record no-show <span>!</span></button>
                        </div>
                      ))}
                  </div>
                )}
              {event.status === "active" &&
                registrations.some((item) =>
                  (item.attendanceStatus === "no_show_pending" ||
                    item.attendanceStatus === "disputed") &&
                  item.settlementStatus === "held",
                ) && (
                <div className="no-show-list">
                  <p className="eyebrow">NO-SHOW · REFUND OR PAYOUT</p>
                  {registrations
                    .filter((item) =>
                      (item.attendanceStatus === "no_show_pending" ||
                        item.attendanceStatus === "disputed") &&
                      item.settlementStatus === "held",
                    )
                    .map((registration) => (
                        <div className="settlement-row" key={registration.address}>
                          <span>{registration.attendee.slice(0, 7)}…{registration.attendee.slice(-7)} · {formatUsdc(registration.depositAmount)} USDC · No-show recorded</span>
                          <button className="button-secondary" onClick={() => refundNoShow(event, registration)}>Refund attendee <span>↻</span></button>
                          <button className="button-primary" onClick={() => settleNoShow(event, registration)}>Pay organizer <span>→</span></button>
                        </div>
                      ))}
                </div>
                )}
              {selectedEvent?.address === event.address && (
                <div className="checkin-panel">
                  <div className="form-heading">
                    <div><p className="eyebrow">AUTHORIZED SCANNER</p><h4>Check in a reservation.</h4></div>
                    <button className="icon-close" onClick={() => setSelectedEvent(null)} aria-label="Close check-in">×</button>
                  </div>
                  <QrScanner
                    onDetected={(value) => {
                      setCredential(value);
                      setScanError(null);
                    }}
                    onError={setScanError}
                  />
                  <label className="form-field">
                    Or paste the pass code
                    <textarea
                      rows={2}
                      value={credential}
                      onChange={(change) => setCredential(change.target.value)}
                      placeholder="HELD1|event|attendee|registration"
                    />
                  </label>
                  {scanError && <p className="transaction-error" role="alert">{scanError}</p>}
                  <button
                    className="button-primary"
                    onClick={() => checkIn(event)}
                    disabled={!credential || approval.isSimulating}
                  >
                    {approval.isSimulating ? "Simulating check-in…" : "Validate and review"}
                    <span>→</span>
                  </button>
                  <p className="fine-print">The program rejects invalid, expired, wrong-event and duplicate check-ins. An organizer check-in is an attestation, not independent proof of physical attendance.</p>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <TransactionApprovalDialog approval={approval} />
    </section>
  );
}
