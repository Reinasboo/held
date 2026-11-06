import { createRealtime, rawSql } from "@neon/realtime/server";

type OrganizerEventRow = {
  address: string;
  reserved_count: number;
  held_amount: string;
  status: "active" | "cancelled";
  synced_at: Date;
  image_sha256: string | null;
};

function createRealtimeServer() {
  const secret = process.env.NEON_REALTIME_SECRET;
  const connectionString = process.env.DATABASE_URL;
  if (!secret || !connectionString) {
    throw new Error("NEON_REALTIME_SECRET and DATABASE_URL are required.");
  }
  const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!database) throw new Error("DATABASE_URL must include a database name.");
  return createRealtime({ secret, db: database });
}

export function sealOrganizerEventsQuery(organizer: string) {
  const query = rawSql<OrganizerEventRow>(
    `select event.address, event.reserved_count, event.held_amount::text as held_amount,
       event.status, event.synced_at, image.sha256 as image_sha256
     from public.held_events as event
     left join public.held_event_images as image
       on image.event_address = event.address
     where event.organizer = $1
     order by event.address`,
    [organizer],
  );
  return createRealtimeServer().seal({ query });
}
