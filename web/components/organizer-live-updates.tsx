"use client";

import { useLiveQuery } from "@neon/realtime-react";
import type { SealedLiveQuery } from "@neon/realtime/client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Address } from "@solana/kit";
import { RealtimeReadyContext } from "@/components/providers";
import type { OrganizerLiveEvent } from "@/lib/organizer-live-events";

const responseSchema = z.object({
  query: z.object({
    capability: z.string(),
    queryFingerprint: z.string(),
    expiresAt: z.number(),
  }),
});

async function requestQuery(
  organizer: Address,
): Promise<SealedLiveQuery<OrganizerLiveEvent>> {
  const response = await fetch("/api/realtime/organizer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizer }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "Could not subscribe to live organizer updates.";
    throw new Error(error);
  }
  return responseSchema.parse(result).query;
}

function OrganizerQuerySubscription({
  query,
  refreshQuery,
  onUpdate,
}: {
  query: SealedLiveQuery<OrganizerLiveEvent>;
  refreshQuery: () => Promise<SealedLiveQuery<OrganizerLiveEvent>>;
  onUpdate: () => void;
}) {
  const snapshot = useLiveQuery(query, { refreshQuery });
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot.data) return;
    const next = JSON.stringify(snapshot.data);
    if (previous.current === null) {
      previous.current = next;
      return;
    }
    if (previous.current !== next) {
      previous.current = next;
      onUpdate();
    }
  }, [onUpdate, snapshot.data]);

  return (
    <p className="realtime-status" role="status">
      {snapshot.status === "live"
        ? "Live updates connected."
        : snapshot.status === "error"
          ? `Live updates stopped: ${snapshot.error.message}`
          : snapshot.status === "stale"
            ? "Renewing live updates…"
            : "Connecting to live updates…"}
    </p>
  );
}

export function OrganizerLiveUpdates({
  organizer,
  onUpdate,
}: {
  organizer: Address;
  onUpdate: () => void;
}) {
  const realtimeReady = useContext(RealtimeReadyContext);
  const [query, setQuery] = useState<SealedLiveQuery<OrganizerLiveEvent> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshQuery = useCallback(
    () => requestQuery(organizer),
    [organizer],
  );

  useEffect(() => {
    let active = true;
    refreshQuery()
      .then((next) => {
        if (active) {
          setQuery(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not subscribe to live organizer updates.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [refreshQuery]);

  if (!realtimeReady) {
    return <p className="realtime-status" role="status">Connecting to Neon Realtime…</p>;
  }
  if (error) {
    return <p className="realtime-status transaction-error" role="alert">{error}</p>;
  }
  if (!query) {
    return <p className="realtime-status" role="status">Connecting to live updates…</p>;
  }
  return (
    <OrganizerQuerySubscription
      query={query}
      refreshQuery={refreshQuery}
      onUpdate={onUpdate}
    />
  );
}
