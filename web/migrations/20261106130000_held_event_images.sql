create table if not exists public.held_event_images (
  event_address text primary key references public.held_events(address) on delete cascade,
  bucket_key text not null unique,
  content_type text not null check (
    content_type in ('image/jpeg', 'image/png', 'image/webp')
  ),
  sha256 text not null check (length(sha256) = 64),
  updated_at timestamptz not null default now()
);
