create extension if not exists pgcrypto;

create table if not exists public.held_events (
  address text primary key,
  organizer text not null,
  mint text not null,
  event_seed text not null,
  name text not null,
  description text not null,
  location text not null,
  time_zone text not null,
  event_start_at bigint not null,
  deposit_amount numeric(20, 0) not null,
  capacity integer not null,
  reserved_count integer not null,
  held_amount numeric(20, 0) not null,
  registration_open_at bigint not null,
  registration_close_at bigint not null,
  cancellation_deadline bigint not null,
  check_in_start_at bigint not null,
  check_in_end_at bigint not null,
  dispute_window_seconds bigint not null,
  policy_hash text not null,
  status text not null check (status in ('active', 'cancelled')),
  synced_at timestamptz not null default now()
);

create table if not exists public.held_registrations (
  address text primary key,
  event_address text not null references public.held_events(address),
  attendee text not null,
  deposit_amount numeric(20, 0) not null,
  policy_hash text not null,
  reservation_status text not null check (reservation_status in ('confirmed', 'cancelled')),
  attendance_status text not null check (
    attendance_status in ('not_checked_in', 'checked_in', 'no_show_pending', 'disputed')
  ),
  settlement_status text not null check (
    settlement_status in ('held', 'refunded', 'paid_to_organizer')
  ),
  checked_in_by text not null,
  checked_in_at bigint not null,
  no_show_marked_at bigint not null,
  synced_at timestamptz not null default now()
);

create index if not exists held_registrations_event_idx
  on public.held_registrations(event_address);
create index if not exists held_registrations_attendee_idx
  on public.held_registrations(attendee);

create table if not exists public.held_transactions (
  signature text primary key,
  event_address text not null references public.held_events(address),
  registration_address text not null references public.held_registrations(address),
  block_time bigint,
  failed boolean not null,
  indexed_at timestamptz not null default now()
);

create index if not exists held_transactions_registration_idx
  on public.held_transactions(registration_address, block_time desc);

create table if not exists public.notification_subscriptions (
  registration_address text primary key references public.held_registrations(address),
  attendee_wallet text not null,
  email text not null,
  verified_at timestamptz,
  verification_token_hash text,
  verification_expires_at timestamptz,
  last_verification_sent_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  registration_address text not null references public.held_registrations(address),
  notification_type text not null check (notification_type in (
    'reservation_confirmed',
    'event_cancelled',
    'check_in_recorded',
    'refund_issued',
    'no_show_recorded',
    'no_show_settled',
    'event_reminder'
  )),
  status text not null default 'pending' check (
    status in ('pending', 'sending', 'sent', 'failed')
  ),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (registration_address, notification_type)
);

create index if not exists notification_outbox_pending_idx
  on public.notification_outbox(status, next_attempt_at);

create or replace function public.enqueue_registration_notification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.reservation_status = 'confirmed' then
      insert into public.notification_outbox(registration_address, notification_type)
      values (new.address, 'reservation_confirmed')
      on conflict (registration_address, notification_type) do nothing;
    end if;
    if new.attendance_status = 'checked_in' then
      insert into public.notification_outbox(registration_address, notification_type)
      values (new.address, 'check_in_recorded')
      on conflict (registration_address, notification_type) do nothing;
    elsif new.attendance_status = 'no_show_pending' then
      insert into public.notification_outbox(registration_address, notification_type)
      values (new.address, 'no_show_recorded')
      on conflict (registration_address, notification_type) do nothing;
    end if;
    if new.settlement_status = 'refunded' then
      insert into public.notification_outbox(registration_address, notification_type)
      values (new.address, 'refund_issued')
      on conflict (registration_address, notification_type) do nothing;
    elsif new.settlement_status = 'paid_to_organizer' then
      insert into public.notification_outbox(registration_address, notification_type)
      values (new.address, 'no_show_settled')
      on conflict (registration_address, notification_type) do nothing;
    end if;
    if exists (
      select 1
      from public.held_events as event
      where event.address = new.event_address
        and event.status = 'cancelled'
    ) and new.settlement_status = 'held' then
      insert into public.notification_outbox(registration_address, notification_type)
      values (new.address, 'event_cancelled')
      on conflict (registration_address, notification_type) do nothing;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.attendance_status is distinct from new.attendance_status then
      if new.attendance_status = 'checked_in' then
        insert into public.notification_outbox(registration_address, notification_type)
        values (new.address, 'check_in_recorded')
        on conflict (registration_address, notification_type) do nothing;
      elsif new.attendance_status = 'no_show_pending' then
        insert into public.notification_outbox(registration_address, notification_type)
        values (new.address, 'no_show_recorded')
        on conflict (registration_address, notification_type) do nothing;
      end if;
    end if;
    if old.settlement_status is distinct from new.settlement_status then
      if new.settlement_status = 'refunded' then
        insert into public.notification_outbox(registration_address, notification_type)
        values (new.address, 'refund_issued')
        on conflict (registration_address, notification_type) do nothing;
      elsif new.settlement_status = 'paid_to_organizer' then
        insert into public.notification_outbox(registration_address, notification_type)
        values (new.address, 'no_show_settled')
        on conflict (registration_address, notification_type) do nothing;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists held_registration_notifications on public.held_registrations;
create trigger held_registration_notifications
after insert or update on public.held_registrations
for each row execute function public.enqueue_registration_notification();

create or replace function public.enqueue_event_cancellation_notifications()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status is distinct from new.status and new.status = 'cancelled' then
    insert into public.notification_outbox(registration_address, notification_type)
    select registration.address, 'event_cancelled'
    from public.held_registrations as registration
    where registration.event_address = new.address
      and registration.settlement_status = 'held'
    on conflict (registration_address, notification_type) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists held_event_cancellation_notifications on public.held_events;
create trigger held_event_cancellation_notifications
after update on public.held_events
for each row execute function public.enqueue_event_cancellation_notifications();

create or replace function public.queue_held_event_reminders()
returns integer
language plpgsql
set search_path = public
as $$
declare
  queued_count integer;
begin
  insert into public.notification_outbox(registration_address, notification_type)
  select registration.address, 'event_reminder'
  from public.held_registrations as registration
  join public.held_events as event on event.address = registration.event_address
  where event.status = 'active'
    and event.event_start_at between extract(epoch from now())::bigint
      and extract(epoch from now() + interval '24 hours')::bigint
    and registration.reservation_status = 'confirmed'
    and registration.attendance_status = 'not_checked_in'
    and registration.settlement_status = 'held'
  on conflict (registration_address, notification_type) do nothing;
  get diagnostics queued_count = row_count;
  return queued_count;
end;
$$;

create or replace function public.claim_held_notifications(p_limit integer default 25)
returns table (
  id uuid,
  registration_address text,
  event_address text,
  notification_type text,
  attendee_email text,
  event_name text,
  event_start_at bigint,
  event_time_zone text,
  dispute_window_seconds bigint,
  no_show_marked_at bigint,
  deposit_amount numeric,
  attendee_wallet text,
  organizer_wallet text,
  attempt_count integer
)
language plpgsql
set search_path = public
as $$
begin
  return query
  with candidates as (
    select outbox.id
    from public.notification_outbox as outbox
    join public.notification_subscriptions as subscription
      on subscription.registration_address = outbox.registration_address
    where subscription.verified_at is not null
      and subscription.unsubscribed_at is null
      and outbox.next_attempt_at <= now()
      and (
        outbox.status in ('pending', 'failed')
        or (outbox.status = 'sending' and outbox.updated_at < now() - interval '10 minutes')
      )
    order by outbox.created_at
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update of outbox skip locked
  ),
  claimed as (
    update public.notification_outbox as outbox
    set status = 'sending',
        attempt_count = outbox.attempt_count + 1,
        updated_at = now()
    from candidates
    where outbox.id = candidates.id
    returning outbox.id, outbox.registration_address, outbox.notification_type,
      outbox.attempt_count
  )
  select claimed.id,
    claimed.registration_address,
    registration.event_address,
    claimed.notification_type,
    subscription.email,
    event.name,
    event.event_start_at,
    event.time_zone,
    event.dispute_window_seconds,
    registration.no_show_marked_at,
    registration.deposit_amount,
    registration.attendee,
    event.organizer,
    claimed.attempt_count
  from claimed
  join public.notification_subscriptions as subscription
    on subscription.registration_address = claimed.registration_address
  join public.held_registrations as registration
    on registration.address = claimed.registration_address
  join public.held_events as event
    on event.address = registration.event_address;
end;
$$;

create or replace function public.retry_held_notifications()
returns integer
language plpgsql
set search_path = public
as $$
declare
  retried_count integer;
begin
  update public.notification_outbox
  set status = 'pending',
      next_attempt_at = now(),
      last_error = null,
      updated_at = now()
  where status = 'failed';
  get diagnostics retried_count = row_count;
  return retried_count;
end;
$$;
