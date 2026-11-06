"use client";

import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
  WalletReadyGate,
} from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { useEffect, useState } from "react";
import { LiveEventDetail } from "@/components/live-event-detail";
import { OrganizerView } from "@/components/organizer-view";
import { EventCoverImage } from "@/components/event-cover";
import type { AppClient } from "@/components/providers";
import { ReservationsView } from "@/components/reservations-view";
import {
  formatUsdc,
  isHeldConfigured,
  loadEvents,
  type EventAccount,
} from "@/lib/held-program";

type View = "events" | "reservations" | "organize";

const eventPreview = {
  title: "Build together, better",
  category: "COMMUNITY WORKSHOP",
  date: "Saturday, November 21, 2026",
  time: "10:00 AM – 1:00 PM",
  place: "The Assembly, San Francisco",
  description:
    "A hands-on morning for people building products with intention. Bring a project, a question, or just your curiosity.",
  organizer: "Common Ground",
  capacity: 100,
  reserved: 72,
  deposit: "$5.00",
};

const supportedWallets = [
  { name: "Phantom", url: "https://phantom.app/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/download" },
];

function WalletControl() {
  const client = useClient<AppClient>();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect, isRunning, error } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);
  const [open, setOpen] = useState(false);
  const sortedWallets = [...wallets].sort((left, right) => {
    const priority = (name: string) => {
      const index = supportedWallets.findIndex((wallet) =>
        name.toLowerCase().includes(wallet.name.toLowerCase()),
      );
      return index === -1 ? supportedWallets.length : index;
    };
    return priority(left.name) - priority(right.name);
  });

  if (connected) {
    const address = connected.account.address;
    return (
      <button
        className="wallet-button connected"
        onClick={() => disconnect()}
        title="Disconnect wallet"
      >
        <span className="status-dot" />
        {address.slice(0, 4)}…{address.slice(-4)}
        <span aria-hidden="true">⌄</span>
      </button>
    );
  }

  return (
    <div className="wallet-control">
      <button
        className="wallet-button"
        onClick={() => setOpen((value) => !value)}
        disabled={isRunning}
      >
        {isRunning ? "Connecting…" : "Connect wallet"}
        <span aria-hidden="true">↗</span>
      </button>
      {open && (
        <div className="wallet-menu">
          <p className="eyebrow">SOLANA DEVNET</p>
          {wallets.length === 0 ? (
            <>
              <p className="wallet-empty">No wallet detected in this browser. Install Phantom, Solflare or Backpack, then refresh.</p>
              <div className="wallet-install-links">
                {supportedWallets.map((wallet) => (
                  <a key={wallet.name} href={wallet.url} target="_blank" rel="noreferrer">
                    Get {wallet.name} ↗
                  </a>
                ))}
              </div>
            </>
          ) : (
            sortedWallets.map((wallet) => (
              <button
                className="wallet-option"
                key={wallet.name}
                onClick={() => {
                  connect(wallet);
                  setOpen(false);
                }}
              >
                {wallet.name}
                <span aria-hidden="true">→</span>
              </button>
            ))
          )}
          {wallets.length > 0 && (
            <p className="wallet-empty wallet-support-note">
              Phantom, Solflare and Backpack are supported when installed in this browser.
            </p>
          )}
          {error instanceof Error && (
            <p className="inline-error">{error.message}</p>
          )}
          <p className="wallet-footnote">
            HELD never asks for your recovery phrase.
          </p>
        </div>
      )}
    </div>
  );
}

function WalletArea() {
  const client = useClient<AppClient>();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!mounted) {
    return <span className="wallet-loading">Loading wallet options…</span>;
  }

  return (
    <WalletReadyGate
      client={client}
      fallback={<span className="wallet-loading">Loading wallet options…</span>}
    >
      <WalletControl />
    </WalletReadyGate>
  );
}

function EventCard({
  onOpen,
}: {
  onOpen: () => void;
}) {
  return (
    <article className="event-card">
      <div className="event-art">
        <div className="art-shape art-shape-one" />
        <div className="art-shape art-shape-two" />
        <span className="event-art-label">A ROOM TO MAKE THINGS</span>
        <span className="event-art-mark">cg.</span>
        <div className="preview-label">PREVIEW</div>
      </div>
      <div className="event-card-content">
        <div className="event-meta-row">
          <span className="category">{eventPreview.category}</span>
          <span className="spots">
            {eventPreview.capacity - eventPreview.reserved} places left
          </span>
        </div>
        <h3>{eventPreview.title}</h3>
        <div className="event-detail-line">
          <span className="detail-icon">◷</span>
          <span>{eventPreview.date} · {eventPreview.time}</span>
        </div>
        <div className="event-detail-line">
          <span className="detail-icon">⌖</span>
          <span>{eventPreview.place}</span>
        </div>
        <div className="card-bottom">
          <div>
            <span className="deposit-caption">USDC SHOW-UP DEPOSIT</span>
            <strong>{eventPreview.deposit} <small>USDC</small></strong>
          </div>
          <button className="circle-arrow" onClick={onOpen} aria-label="View event details">
            →
          </button>
        </div>
      </div>
    </article>
  );
}

function OnChainEventCard({
  event,
  onOpen,
}: {
  event: EventAccount;
  onOpen: (address: string) => void;
}) {
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: event.timeZone,
  }).format(new Date(Number(event.eventStartAt) * 1000));
  return (
    <article className="event-card">
      <button className="onchain-event-open" onClick={() => onOpen(event.address)} aria-label={`View ${event.name}`}>
        <div className="event-art">
          <EventCoverImage eventAddress={event.address} />
          <div className="art-shape art-shape-one" />
          <div className="art-shape art-shape-two" />
          <span className="event-art-label">A PLACE, HELD · DEVNET</span>
          <span className="event-art-mark">held.</span>
        </div>
        <div className="event-card-content">
          <div className="event-meta-row">
            <span className="category">ON-CHAIN EVENT</span>
            <span className="spots">{event.capacity - event.reservedCount} places left</span>
          </div>
          <h3>{event.name}</h3>
          <div className="event-detail-line"><span className="detail-icon">◷</span><span>{date} · {event.timeZone}</span></div>
          <div className="event-detail-line"><span className="detail-icon">⌖</span><span>{event.location}</span></div>
          <div className="card-bottom">
            <div><span className="deposit-caption">USDC SHOW-UP DEPOSIT</span><strong>{formatUsdc(event.depositAmount)} <small>USDC</small></strong></div>
            <span className="circle-arrow" aria-hidden="true">→</span>
          </div>
        </div>
      </button>
    </article>
  );
}

function PreviewEventDetail({ onBack }: { onBack: () => void }) {
  return (
    <section className="detail-layout" aria-labelledby="event-title">
      <button className="text-back" onClick={onBack}>← All events</button>
      <div className="detail-grid">
        <div>
          <div className="event-art detail-art">
            <div className="art-shape art-shape-one" />
            <div className="art-shape art-shape-two" />
            <span className="event-art-label">A ROOM TO MAKE THINGS</span>
            <span className="event-art-mark">cg.</span>
            <div className="preview-label">PREVIEW</div>
          </div>
          <div className="detail-copy">
            <span className="category">{eventPreview.category}</span>
            <h1 id="event-title">{eventPreview.title}</h1>
            <p>{eventPreview.description}</p>
            <h2>Hosted by {eventPreview.organizer}</h2>
          </div>
        </div>
        <aside className="reservation-panel">
          <p className="eyebrow">YOUR PLACE, HELD</p>
          <h2>Everything, up front.</h2>
          <p className="configuration-note">This sample is for preview only. Reservations are unavailable until a HELD Devnet program is configured.</p>
        </aside>
      </div>
    </section>
  );
}

export function HeldApp() {
  const client = useClient<AppClient>();
  const [view, setView] = useState<View>("events");
  const [selectedEventAddress, setSelectedEventAddress] = useState<string | null>(null);
  const [events, setEvents] = useState<EventAccount[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsRefreshKey, setEventsRefreshKey] = useState(0);
  const configured = isHeldConfigured();

  function navigate(next: View) {
    setView(next);
    if (next !== "events") {
      setSelectedEventAddress(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("event");
      window.history.replaceState({}, "", url);
    }
  }

  function openEvent(eventAddress: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("event", eventAddress);
    window.history.pushState({}, "", url);
    setSelectedEventAddress(eventAddress);
    setView("events");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openPreview() {
    const url = new URL(window.location.href);
    url.searchParams.set("event", "preview");
    window.history.pushState({}, "", url);
    setSelectedEventAddress("preview");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeEvent() {
    const url = new URL(window.location.href);
    url.searchParams.delete("event");
    window.history.pushState({}, "", url);
    setSelectedEventAddress(null);
  }

  function refreshEvents() {
    setEventsRefreshKey((value) => value + 1);
  }

  useEffect(() => {
    const syncEventFromUrl = () => {
      const eventAddress = new URLSearchParams(window.location.search).get("event");
      setSelectedEventAddress(eventAddress);
      if (eventAddress) setView("events");
    };
    syncEventFromUrl();
    window.addEventListener("popstate", syncEventFromUrl);
    return () => window.removeEventListener("popstate", syncEventFromUrl);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        if (!configured) return [];
        setEventsLoading(true);
        setEventsError(null);
        return loadEvents(client);
      })
      .then((loaded) => {
        if (active) {
          setEvents(loaded.filter((event) => event.status === "active"));
          setEventsError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setEventsError(
            reason instanceof Error ? reason.message : "Could not load events from Devnet.",
          );
        }
      })
      .finally(() => {
        if (active) setEventsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, configured, eventsRefreshKey]);

  function reservationConfirmed() {
    refreshEvents();
  }

  return (
    <main>
      <div className="announcement">
        <span className="announcement-dot" />
        DEVNET PREVIEW
        <span className="announcement-separator">·</span>
        Test tokens only. No real-world value.
        <span className="announcement-arrow">↗</span>
      </div>
      <header className="site-header">
        <button className="wordmark" onClick={() => navigate("events")} aria-label="HELD home">
          held<span>.</span>
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={view === "events" ? "nav-link active" : "nav-link"} onClick={() => navigate("events")}>Find events</button>
          <button className={view === "reservations" ? "nav-link active" : "nav-link"} onClick={() => navigate("reservations")}>Your reservations</button>
          <button className={view === "organize" ? "nav-link active" : "nav-link"} onClick={() => navigate("organize")}>For organizers</button>
        </nav>
        <WalletArea />
      </header>

      <div className="network-bar">
        <span className="network-indicator" />
        SOLANA DEVNET
        <span className="network-divider">/</span>
        <span>PREVIEW MODE</span>
      </div>

      {view === "events" && (
        selectedEventAddress === "preview" ? (
          <PreviewEventDetail onBack={closeEvent} />
        ) : selectedEventAddress ? (
          <LiveEventDetail
            eventAddress={selectedEventAddress}
            onBack={closeEvent}
            onReservationConfirmed={reservationConfirmed}
          />
        ) : (
          <>
            <section className="hero">
              <div className="hero-copy">
                <p className="eyebrow"><span className="eyebrow-line" /> GOOD PLANS. BETTER FOLLOW-THROUGH.</p>
                <h1>Your place is<br />held<span>.</span></h1>
                <p className="hero-description">
                  Put down a small USDC deposit to save your spot. Show up or cancel by the deadline and get it back.
                </p>
                <button className="text-link" onClick={() => navigate("organize")}>
                  Hosting? Set the terms. <span>↗</span>
                </button>
              </div>
              <div className="hero-aside">
                <div className="hero-mark">h<span>.</span></div>
                <div className="hero-note">
                  <span className="note-line" />
                  <p>Good plans. Fewer<br />empty chairs.</p>
                </div>
              </div>
              <div className="hero-index">01 — 03</div>
            </section>
            <section className="homepage-policy" aria-label="How the deposit works">
              <div>
                <strong>Show up</strong>
                <span>The organizer checks you in. Your deposit comes back.</span>
              </div>
              <div>
                <strong>Plans change?</strong>
                <span>Cancel before the deadline for a full refund.</span>
              </div>
              <div>
                <strong>Miss the event?</strong>
                <span>The organizer gets your deposit—or can choose to refund you.</span>
              </div>
              <div>
                <strong>Organizer cancels?</strong>
                <span>You get a full refund. No hard feelings.</span>
              </div>
            </section>
            <section className="events-section" aria-labelledby="events-title">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">YOUR NEXT YES STARTS HERE</p>
                  <h2 id="events-title">Find your next good plan.</h2>
                </div>
                <button className="filter-button" disabled>All events <span>⌄</span></button>
              </div>
              {!configured && <div className="preview-banner"><span className="preview-banner-icon">i</span>Preview only: this sample isn’t reservable. Live events use Devnet test USDC with no real-world value.</div>}
              {eventsLoading && configured && <p className="state-panel">Loading active events from Solana Devnet…</p>}
              {eventsError && <p className="transaction-error" role="alert">{eventsError}</p>}
              <div className="event-grid">
                {!configured && <EventCard onOpen={openPreview} />}
                {configured && events.map((event) => <OnChainEventCard key={event.address} event={event} onOpen={openEvent} />)}
                {configured && !eventsLoading && !eventsError && events.length === 0 && (
                  <div className="no-events-panel"><h3>The calendar’s looking a little lonely.</h3><p>Be the first to post a plan worth showing up for.</p><button className="text-link" onClick={() => navigate("organize")}>Host the first one ↗</button></div>
                )}
                {!configured && <div className="coming-card"><div className="coming-art"><span>More good things<br />are on their way.</span></div><p>Independent organizers.<br />A little more certainty.</p><span className="coming-soon">COMING SOON</span></div>}
              </div>
            </section>
          </>
        )
      )}
      {view === "reservations" && <ReservationsView onReservationUpdated={refreshEvents} />}
      {view === "organize" && <OrganizerView events={events} configured={configured} onEventOpen={openEvent} onEventsChanged={refreshEvents} />}

      <footer className="site-footer">
        <button className="wordmark footer-mark" onClick={() => navigate("events")}>held<span>.</span></button>
        <p>Clear terms. Better RSVPs. Your deposit back when you show up.</p>
        <span>BUILT ON SOLANA · DEVNET PREVIEW</span>
      </footer>
    </main>
  );
}
