import { neon } from "@neondatabase/serverless";
import type { EventAccount, RegistrationAccount } from "@/lib/held-program";
import { eventSnapshotRow, registrationSnapshotRow } from "@/lib/server/snapshot";

type DatabaseRow = Record<string, unknown>;

let database: ReturnType<typeof neon> | undefined;

export function getDatabase(): ReturnType<typeof neon> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }
  if (!database) {
    database = neon(connectionString);
  }
  return database;
}

export async function queryDatabase<T extends DatabaseRow = DatabaseRow>(
  query: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  return (await getDatabase().query(query, parameters)) as T[];
}

async function upsertJsonRows(rows: unknown[], statement: string): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 200) {
    await queryDatabase(statement, [JSON.stringify(rows.slice(offset, offset + 200))]);
  }
}

export function upsertEventSnapshots(events: EventAccount[]): Promise<void> {
  if (!events.length) return Promise.resolve();
  const statement = `
    insert into public.held_events (
      address, organizer, mint, event_seed, name, description, location, time_zone,
      event_start_at, deposit_amount, capacity, reserved_count, held_amount,
      registration_open_at, registration_close_at, cancellation_deadline,
      check_in_start_at, check_in_end_at, dispute_window_seconds, policy_hash,
      status, synced_at
    )
    select snapshot.address, snapshot.organizer, snapshot.mint, snapshot.event_seed,
      snapshot.name, snapshot.description, snapshot.location, snapshot.time_zone,
      snapshot.event_start_at, snapshot.deposit_amount, snapshot.capacity,
      snapshot.reserved_count, snapshot.held_amount, snapshot.registration_open_at,
      snapshot.registration_close_at, snapshot.cancellation_deadline,
      snapshot.check_in_start_at, snapshot.check_in_end_at,
      snapshot.dispute_window_seconds, snapshot.policy_hash, snapshot.status,
      snapshot.synced_at
    from jsonb_to_recordset($1::jsonb) as snapshot(
      address text, organizer text, mint text, event_seed text, name text,
      description text, location text, time_zone text, event_start_at bigint,
      deposit_amount numeric, capacity integer, reserved_count integer,
      held_amount numeric, registration_open_at bigint, registration_close_at bigint,
      cancellation_deadline bigint, check_in_start_at bigint, check_in_end_at bigint,
      dispute_window_seconds bigint, policy_hash text, status text, synced_at timestamptz
    )
    on conflict (address) do update set
      organizer = excluded.organizer,
      mint = excluded.mint,
      event_seed = excluded.event_seed,
      name = excluded.name,
      description = excluded.description,
      location = excluded.location,
      time_zone = excluded.time_zone,
      event_start_at = excluded.event_start_at,
      deposit_amount = excluded.deposit_amount,
      capacity = excluded.capacity,
      reserved_count = excluded.reserved_count,
      held_amount = excluded.held_amount,
      registration_open_at = excluded.registration_open_at,
      registration_close_at = excluded.registration_close_at,
      cancellation_deadline = excluded.cancellation_deadline,
      check_in_start_at = excluded.check_in_start_at,
      check_in_end_at = excluded.check_in_end_at,
      dispute_window_seconds = excluded.dispute_window_seconds,
      policy_hash = excluded.policy_hash,
      status = excluded.status,
      synced_at = excluded.synced_at
  `;
  return upsertJsonRows(events.map(eventSnapshotRow), statement);
}

export function upsertRegistrationSnapshots(
  registrations: RegistrationAccount[],
): Promise<void> {
  if (!registrations.length) return Promise.resolve();
  const statement = `
    insert into public.held_registrations (
      address, event_address, attendee, deposit_amount, policy_hash,
      reservation_status, attendance_status, settlement_status, checked_in_by,
      checked_in_at, no_show_marked_at, synced_at
    )
    select snapshot.address, snapshot.event_address, snapshot.attendee,
      snapshot.deposit_amount, snapshot.policy_hash, snapshot.reservation_status,
      snapshot.attendance_status, snapshot.settlement_status, snapshot.checked_in_by,
      snapshot.checked_in_at, snapshot.no_show_marked_at, snapshot.synced_at
    from jsonb_to_recordset($1::jsonb) as snapshot(
      address text, event_address text, attendee text, deposit_amount numeric,
      policy_hash text, reservation_status text, attendance_status text,
      settlement_status text, checked_in_by text, checked_in_at bigint,
      no_show_marked_at bigint, synced_at timestamptz
    )
    on conflict (address) do update set
      event_address = excluded.event_address,
      attendee = excluded.attendee,
      deposit_amount = excluded.deposit_amount,
      policy_hash = excluded.policy_hash,
      reservation_status = excluded.reservation_status,
      attendance_status = excluded.attendance_status,
      settlement_status = excluded.settlement_status,
      checked_in_by = excluded.checked_in_by,
      checked_in_at = excluded.checked_in_at,
      no_show_marked_at = excluded.no_show_marked_at,
      synced_at = excluded.synced_at
  `;
  return upsertJsonRows(registrations.map(registrationSnapshotRow), statement);
}

export function upsertTransactionSnapshots(
  transactions: {
    signature: string;
    event_address: string;
    registration_address: string;
    block_time: number | null;
    failed: boolean;
    indexed_at: string;
  }[],
): Promise<void> {
  if (!transactions.length) return Promise.resolve();
  const statement = `
    insert into public.held_transactions (
      signature, event_address, registration_address, block_time, failed, indexed_at
    )
    select snapshot.signature, snapshot.event_address, snapshot.registration_address,
      snapshot.block_time, snapshot.failed, snapshot.indexed_at
    from jsonb_to_recordset($1::jsonb) as snapshot(
      signature text, event_address text, registration_address text, block_time bigint,
      failed boolean, indexed_at timestamptz
    )
    on conflict (signature) do update set
      event_address = excluded.event_address,
      registration_address = excluded.registration_address,
      block_time = excluded.block_time,
      failed = excluded.failed,
      indexed_at = excluded.indexed_at
  `;
  return upsertJsonRows(transactions, statement);
}
