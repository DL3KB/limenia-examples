-- Processed Limenia webhook event IDs, for deduplication.
-- Only the Edge Functions use this table, with the service role key, which bypasses RLS.
create table if not exists public.limenia_webhook_events (
  id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.limenia_webhook_events enable row level security;
-- No policies: the app (anon and authenticated roles) cannot read or write it.

-- Optional cleanup, e.g. with pg_cron:
--   delete from public.limenia_webhook_events where processed_at < now() - interval '30 days';
