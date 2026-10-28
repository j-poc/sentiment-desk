-- Cloud-owned source and user research state for the three core workflows.
-- Live acquisition is performed by server-side Edge Functions only.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.core_source_runs (
  id uuid primary key default gen_random_uuid(),
  request_key uuid,
  source_id text not null check (source_id in (
    'sec_company_tickers_exchange',
    'sec_companyfacts',
    'sec_submissions'
  )),
  source_url text not null check (source_url like 'https://%'),
  adapter_version text not null check (length(adapter_version) between 1 and 80),
  trigger_kind text not null check (trigger_kind in ('manual', 'scheduled')),
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  started_at timestamptz not null,
  retrieved_at timestamptz,
  completed_at timestamptz,
  http_status integer check (http_status is null or http_status between 100 and 599),
  response_sha256 text check (response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$'),
  response_bytes bigint check (response_bytes is null or response_bytes between 0 and 16777216),
  row_count integer check (row_count is null or row_count between 0 and 500000),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  unique (id, source_id),
  unique (id, source_id, source_url),
  unique (source_id, request_key),
  unique (id, response_sha256),
  check ((status = 'running' and completed_at is null) or (status <> 'running' and completed_at is not null)),
  check (status not in ('success', 'partial') or (retrieved_at is not null and response_sha256 is not null and response_bytes is not null and row_count is not null)),
  check (status <> 'failed' or failure_code is not null)
);

create index core_source_runs_source_created_idx
  on public.core_source_runs (source_id, created_at desc);

create table public.sec_source_payloads (
  source_run_id uuid primary key references public.core_source_runs(id),
  response_sha256 text not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
  response_body text not null check (octet_length(response_body) between 1 and 16777216),
  stored_at timestamptz not null default now(),
  foreign key (source_run_id, response_sha256)
    references public.core_source_runs(id, response_sha256)
);

create table public.sec_issuer_directory_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_run_id uuid not null unique,
  source_id text not null default 'sec_company_tickers_exchange'
    check (source_id = 'sec_company_tickers_exchange'),
  source_url text not null check (source_url = 'https://www.sec.gov/files/company_tickers_exchange.json'),
  source_response_sha256 text not null check (source_response_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text not null check (length(parser_version) between 1 and 80),
  retrieved_at timestamptz not null,
  completed_at timestamptz,
  row_count integer not null check (row_count between 1 and 500000),
  created_at timestamptz not null default now(),
  unique (id, source_response_sha256),
  foreign key (source_run_id, source_id, source_url)
    references public.core_source_runs(id, source_id, source_url),
  foreign key (source_run_id, source_response_sha256)
    references public.core_source_runs(id, response_sha256),
  check (completed_at is null or completed_at >= retrieved_at)
);

create table public.sec_issuer_directory_entries (
  snapshot_id uuid not null references public.sec_issuer_directory_snapshots(id),
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  ticker text not null check (ticker = upper(ticker) and length(ticker) between 1 and 14),
  issuer_name text not null check (length(issuer_name) between 1 and 512),
  exchange text check (exchange is null or length(exchange) <= 80),
  source_row_sha256 text not null check (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (snapshot_id, cik, ticker),
  unique (snapshot_id, cik, ticker, issuer_name, exchange)
);

create index sec_issuer_directory_name_trgm_idx
  on public.sec_issuer_directory_entries using gin (issuer_name extensions.gin_trgm_ops);
create index sec_issuer_directory_ticker_idx
  on public.sec_issuer_directory_entries (ticker);
create index sec_issuer_directory_cik_idx
  on public.sec_issuer_directory_entries (cik);

create table public.sec_issuer_directory_head (
  dataset text primary key check (dataset = 'company_tickers_exchange'),
  snapshot_id uuid not null references public.sec_issuer_directory_snapshots(id),
  updated_at timestamptz not null
);

-- The lease table is server-only. It serializes refreshes across app instances.
create table public.core_source_refresh_leases (
  source_id text primary key check (source_id in (
    'sec_company_tickers_exchange',
    'sec_companyfacts',
    'sec_submissions'
  )),
  last_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  next_allowed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((lease_token is null) = (lease_until is null))
);

create function public.claim_core_source_refresh(
  p_source_id text,
  p_lease_token uuid,
  p_cooldown_seconds integer default 900,
  p_lease_seconds integer default 120
)
returns table (claimed boolean, next_allowed_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_at timestamptz := clock_timestamp();
  changed integer;
  retry_at timestamptz;
begin
  if p_source_id not in ('sec_company_tickers_exchange', 'sec_companyfacts', 'sec_submissions')
    or p_lease_token is null
    or p_cooldown_seconds not between 1 and 21600
    or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid_source_refresh_lease_request' using errcode = '22023';
  end if;
  insert into public.core_source_refresh_leases as lease
    (source_id, last_attempt_at, lease_token, lease_until, next_allowed_at, updated_at)
  values
    (p_source_id, now_at, p_lease_token, now_at + make_interval(secs => p_lease_seconds),
      now_at + make_interval(secs => p_cooldown_seconds), now_at)
  on conflict (source_id) do update set
    last_attempt_at = excluded.last_attempt_at,
    lease_token = excluded.lease_token,
    lease_until = excluded.lease_until,
    next_allowed_at = excluded.next_allowed_at,
    updated_at = excluded.updated_at
  where (lease.lease_until is null or lease.lease_until <= now_at)
    and (lease.next_allowed_at is null or lease.next_allowed_at <= now_at);
  get diagnostics changed = row_count;
  if changed > 0 then
    return query select true, now_at + make_interval(secs => p_cooldown_seconds);
    return;
  end if;
  select greatest(coalesce(l.lease_until, now_at), coalesce(l.next_allowed_at, now_at))
    into retry_at from public.core_source_refresh_leases l where l.source_id = p_source_id;
  return query select false, retry_at;
end;
$$;

create function public.release_core_source_refresh(p_source_id text, p_lease_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.core_source_refresh_leases
    set lease_token = null, lease_until = null, updated_at = clock_timestamp()
    where source_id = p_source_id and lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create function public.defer_core_source_refresh(p_source_id text, p_next_allowed_at timestamptz)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_next_allowed_at < clock_timestamp() or p_next_allowed_at > clock_timestamp() + interval '24 hours' then
    raise exception 'source_retry_after_out_of_range' using errcode = '22023';
  end if;
  update public.core_source_refresh_leases
    set next_allowed_at = greatest(coalesce(next_allowed_at, p_next_allowed_at), p_next_allowed_at),
        updated_at = clock_timestamp()
    where source_id = p_source_id;
end;
$$;

create table public.user_research_issuers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  selected_snapshot_id uuid not null,
  ticker text not null check (ticker = upper(ticker) and length(ticker) between 1 and 14),
  issuer_name text not null check (length(issuer_name) between 1 and 512),
  exchange text check (exchange is null or length(exchange) <= 80),
  created_at timestamptz not null default now(),
  unique (user_id, cik),
  unique (id, user_id, cik),
  foreign key (selected_snapshot_id, cik, ticker, issuer_name, exchange)
    references public.sec_issuer_directory_entries(snapshot_id, cik, ticker, issuer_name, exchange)
);

create table public.sec_companyfacts_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_run_id uuid not null unique,
  source_id text not null default 'sec_companyfacts' check (source_id = 'sec_companyfacts'),
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  source_response_sha256 text not null check (source_response_sha256 ~ '^[0-9a-f]{64}$'),
  source_url text not null check (source_url ~ '^https://data\.sec\.gov/api/xbrl/companyfacts/CIK[0-9]{10}\.json$'),
  retrieved_at timestamptz not null,
  completed_at timestamptz,
  fact_count integer not null check (fact_count between 0 and 5000000),
  parser_version text not null check (length(parser_version) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (id, cik),
  foreign key (source_run_id, source_id, source_url)
    references public.core_source_runs(id, source_id, source_url),
  foreign key (source_run_id, source_response_sha256)
    references public.core_source_runs(id, response_sha256),
  check (substring(source_url from '/CIK([0-9]{10})\.json$') = cik),
  check (completed_at is null or completed_at >= retrieved_at)
);

create table public.sec_companyfacts_head (
  cik text primary key check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  snapshot_id uuid not null,
  updated_at timestamptz not null,
  foreign key (snapshot_id, cik) references public.sec_companyfacts_snapshots(id, cik)
);

create table public.sec_company_fact_values (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  taxonomy text not null check (length(taxonomy) between 1 and 100),
  concept text not null check (length(concept) between 1 and 200),
  unit text not null check (length(unit) between 1 and 80),
  value_text text not null check (length(value_text) between 1 and 120),
  period_start date,
  period_end date not null,
  filed_at date not null,
  form text not null check (length(form) between 1 and 20),
  accession text not null check (accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  fiscal_year integer,
  fiscal_period text,
  reported_decimals text,
  frame text,
  created_at timestamptz not null default now(),
  foreign key (snapshot_id, cik) references public.sec_companyfacts_snapshots(id, cik),
  check (period_start is null or period_start <= period_end),
  unique (snapshot_id, taxonomy, concept, unit, period_start, period_end, filed_at, form, accession, value_text, reported_decimals, frame)
);

create index sec_company_fact_cik_concept_period_idx
  on public.sec_company_fact_values (cik, taxonomy, concept, period_end desc, filed_at desc);

create table public.sec_submissions_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_run_id uuid not null unique,
  source_id text not null default 'sec_submissions' check (source_id = 'sec_submissions'),
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  source_response_sha256 text not null check (source_response_sha256 ~ '^[0-9a-f]{64}$'),
  source_url text not null check (source_url ~ '^https://data\.sec\.gov/submissions/CIK[0-9]{10}\.json$'),
  retrieved_at timestamptz not null,
  completed_at timestamptz,
  filing_count integer not null check (filing_count between 0 and 100000),
  parser_version text not null check (length(parser_version) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (id, cik),
  foreign key (source_run_id, source_id, source_url)
    references public.core_source_runs(id, source_id, source_url),
  foreign key (source_run_id, source_response_sha256)
    references public.core_source_runs(id, response_sha256),
  check (substring(source_url from '/CIK([0-9]{10})\.json$') = cik),
  check (completed_at is null or completed_at >= retrieved_at)
);

create table public.sec_filing_observations (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  accession text not null check (accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  form text not null check (length(form) between 1 and 20),
  filed_at date not null,
  report_period date,
  accepted_at timestamptz,
  primary_document text check (primary_document is null or length(primary_document) <= 260),
  source_url text not null check (source_url like 'https://www.sec.gov/Archives/%'),
  retrieved_at timestamptz not null,
  unique (snapshot_id, cik, accession),
  unique (id, cik),
  foreign key (snapshot_id, cik) references public.sec_submissions_snapshots(id, cik)
);

create index sec_filing_cik_filed_idx
  on public.sec_filing_observations (cik, filed_at desc, accession desc);

create table public.sec_submissions_head (
  cik text primary key check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  snapshot_id uuid not null,
  updated_at timestamptz not null,
  foreign key (snapshot_id, cik) references public.sec_submissions_snapshots(id, cik)
);

create table public.user_company_research_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  issuer_research_id uuid not null,
  companyfacts_snapshot_id uuid not null,
  submissions_snapshot_id uuid,
  decision text not null check (decision in ('investigate_further', 'insufficient_evidence', 'set_aside')),
  rationale text not null check (length(rationale) <= 2000),
  next_check_date date,
  evidence_fact_ids uuid[] not null default '{}',
  evidence_filing_ids uuid[] not null default '{}',
  evidence_digest text not null default repeat('0', 64) check (evidence_digest ~ '^[0-9a-f]{64}$'),
  as_of timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, user_id, cik),
  foreign key (issuer_research_id, user_id, cik)
    references public.user_research_issuers(id, user_id, cik) on delete no action,
  foreign key (companyfacts_snapshot_id, cik)
    references public.sec_companyfacts_snapshots(id, cik),
  foreign key (submissions_snapshot_id, cik)
    references public.sec_submissions_snapshots(id, cik),
  check (cardinality(evidence_fact_ids) <= 100),
  check (cardinality(evidence_filing_ids) <= 100),
  check (as_of <= created_at)
);

create table public.user_company_follows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  issuer_research_id uuid not null,
  created_at timestamptz not null default now(),
  unfollowed_at timestamptz,
  unique (id, user_id, cik),
  foreign key (issuer_research_id, user_id, cik)
    references public.user_research_issuers(id, user_id, cik) on delete no action
);

create unique index user_company_follows_active_user_cik_idx
  on public.user_company_follows (user_id, cik)
  where unfollowed_at is null;

create table public.user_followed_evidence_baselines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  follow_id uuid not null,
  cik text not null check (cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  snapshot_id uuid not null,
  capture_key uuid not null,
  expected_previous_baseline_id uuid,
  version integer not null default 0 check (version > 0),
  captured_at timestamptz not null default clock_timestamp(),
  filing_ids uuid[] not null default '{}',
  filing_count integer generated always as (cardinality(filing_ids)) stored,
  evidence_digest text not null default repeat('0', 64) check (evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (follow_id, version),
  unique (follow_id, capture_key),
  unique (id, user_id, cik),
  foreign key (follow_id, user_id, cik)
    references public.user_company_follows(id, user_id, cik) on delete cascade,
  foreign key (snapshot_id, cik)
    references public.sec_submissions_snapshots(id, cik),
  check (cardinality(filing_ids) <= 50000)
);

create index user_research_issuers_user_created_idx
  on public.user_research_issuers (user_id, created_at desc);
create index user_company_research_decisions_user_created_idx
  on public.user_company_research_decisions (user_id, created_at desc);
create index user_followed_baselines_user_follow_version_idx
  on public.user_followed_evidence_baselines (user_id, follow_id, version desc);

-- Source records are immutable for user-facing roles. Refresh workers use the
-- service role and publish a new snapshot by moving the current head.
alter table public.core_source_runs enable row level security;
alter table public.sec_source_payloads enable row level security;
alter table public.sec_issuer_directory_snapshots enable row level security;
alter table public.sec_issuer_directory_entries enable row level security;
alter table public.sec_issuer_directory_head enable row level security;
alter table public.core_source_refresh_leases enable row level security;
alter table public.user_research_issuers enable row level security;
alter table public.sec_companyfacts_snapshots enable row level security;
alter table public.sec_companyfacts_head enable row level security;
alter table public.sec_company_fact_values enable row level security;
alter table public.sec_submissions_snapshots enable row level security;
alter table public.sec_submissions_head enable row level security;
alter table public.sec_filing_observations enable row level security;
alter table public.user_company_research_decisions enable row level security;
alter table public.user_company_follows enable row level security;
alter table public.user_followed_evidence_baselines enable row level security;

revoke all on public.core_source_runs from anon, authenticated;
revoke all on public.sec_source_payloads from public, anon, authenticated;
revoke all on public.sec_issuer_directory_snapshots from anon, authenticated;
revoke all on public.sec_issuer_directory_entries from anon, authenticated;
revoke all on public.sec_issuer_directory_head from anon, authenticated;
revoke all on public.core_source_refresh_leases from anon, authenticated;
revoke all on public.sec_companyfacts_snapshots from anon, authenticated;
revoke all on public.sec_companyfacts_head from anon, authenticated;
revoke all on public.sec_company_fact_values from anon, authenticated;
revoke all on public.sec_submissions_snapshots from anon, authenticated;
revoke all on public.sec_submissions_head from anon, authenticated;
revoke all on public.sec_filing_observations from anon, authenticated;

grant select on public.core_source_runs to authenticated;
grant select on public.sec_issuer_directory_snapshots to authenticated;
grant select on public.sec_issuer_directory_entries to authenticated;
grant select on public.sec_issuer_directory_head to authenticated;
grant select on public.sec_companyfacts_snapshots to authenticated;
grant select on public.sec_companyfacts_head to authenticated;
grant select on public.sec_company_fact_values to authenticated;
grant select on public.sec_submissions_snapshots to authenticated;
grant select on public.sec_submissions_head to authenticated;
grant select on public.sec_filing_observations to authenticated;
grant all on public.core_source_runs to service_role;
grant all on public.sec_source_payloads to service_role;
grant all on public.sec_issuer_directory_snapshots to service_role;
grant all on public.sec_issuer_directory_entries to service_role;
grant all on public.sec_issuer_directory_head to service_role;
grant all on public.core_source_refresh_leases to service_role;
grant all on public.sec_companyfacts_snapshots to service_role;
grant all on public.sec_companyfacts_head to service_role;
grant all on public.sec_company_fact_values to service_role;
grant all on public.sec_submissions_snapshots to service_role;
grant all on public.sec_submissions_head to service_role;
grant all on public.sec_filing_observations to service_role;

create policy source_runs_read_authenticated on public.core_source_runs
  for select to authenticated using (true);

revoke all on function public.claim_core_source_refresh(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.release_core_source_refresh(text, uuid) from public, anon, authenticated;
revoke all on function public.defer_core_source_refresh(text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_core_source_refresh(text, uuid, integer, integer) to service_role;
grant execute on function public.release_core_source_refresh(text, uuid) to service_role;
grant execute on function public.defer_core_source_refresh(text, timestamptz) to service_role;
create policy issuer_snapshots_read_authenticated on public.sec_issuer_directory_snapshots
  for select to authenticated using (
    completed_at is not null and exists (
      select 1 from public.core_source_runs r
      where r.id = sec_issuer_directory_snapshots.source_run_id and r.status = 'success'
    )
  );
create policy issuer_entries_read_current on public.sec_issuer_directory_entries
  for select to authenticated using (
    exists (
      select 1 from public.sec_issuer_directory_head h
      where h.dataset = 'company_tickers_exchange' and h.snapshot_id = sec_issuer_directory_entries.snapshot_id
    )
  );
create policy issuer_head_read_authenticated on public.sec_issuer_directory_head
  for select to authenticated using (true);
create policy companyfacts_snapshots_read_authenticated on public.sec_companyfacts_snapshots
  for select to authenticated using (
    completed_at is not null and exists (
      select 1 from public.core_source_runs r
      where r.id = sec_companyfacts_snapshots.source_run_id and r.status = 'success'
    )
  );
create policy companyfacts_head_read_authenticated on public.sec_companyfacts_head
  for select to authenticated using (true);
create policy companyfacts_values_read_authenticated on public.sec_company_fact_values
  for select to authenticated using (
    exists (
      select 1 from public.sec_companyfacts_snapshots s
      join public.core_source_runs r on r.id = s.source_run_id
      where s.id = sec_company_fact_values.snapshot_id
        and s.completed_at is not null and r.status = 'success'
    )
  );
create policy submissions_snapshots_read_authenticated on public.sec_submissions_snapshots
  for select to authenticated using (
    completed_at is not null and exists (
      select 1 from public.core_source_runs r
      where r.id = sec_submissions_snapshots.source_run_id and r.status = 'success'
    )
  );
create policy submissions_head_read_authenticated on public.sec_submissions_head
  for select to authenticated using (true);
create policy filings_read_authenticated on public.sec_filing_observations
  for select to authenticated using (
    exists (
      select 1 from public.sec_submissions_snapshots s
      join public.core_source_runs r on r.id = s.source_run_id
      where s.id = sec_filing_observations.snapshot_id
        and s.completed_at is not null and r.status = 'success'
    )
  );

grant select, insert, delete on public.user_research_issuers to authenticated;
grant select, insert on public.user_company_research_decisions to authenticated;
grant select, insert on public.user_company_follows to authenticated;
grant select, insert on public.user_followed_evidence_baselines to authenticated;
grant all on public.user_research_issuers to service_role;
grant all on public.user_company_research_decisions to service_role;
grant all on public.user_company_follows to service_role;
grant all on public.user_followed_evidence_baselines to service_role;

create policy research_issuers_select_own on public.user_research_issuers
  for select to authenticated using (user_id = (select auth.uid()));
create policy research_issuers_insert_own on public.user_research_issuers
  for insert to authenticated with check (
    public.user_research_issuers.user_id = (select auth.uid())
    and exists (
      select 1 from public.sec_issuer_directory_entries e
      join public.sec_issuer_directory_head h
        on h.dataset = 'company_tickers_exchange' and h.snapshot_id = e.snapshot_id
      where e.snapshot_id = public.user_research_issuers.selected_snapshot_id
        and e.cik = public.user_research_issuers.cik
        and e.ticker = public.user_research_issuers.ticker
        and e.issuer_name = public.user_research_issuers.issuer_name
        and e.exchange is not distinct from public.user_research_issuers.exchange
    )
  );
create policy research_issuers_delete_own on public.user_research_issuers
  for delete to authenticated using (user_id = (select auth.uid()));
create policy research_decisions_select_own on public.user_company_research_decisions
  for select to authenticated using (user_id = (select auth.uid()));
create policy research_decisions_insert_own on public.user_company_research_decisions
  for insert to authenticated with check (
    public.user_company_research_decisions.user_id = (select auth.uid())
    and exists (
      select 1 from public.user_research_issuers r
      where r.id = public.user_company_research_decisions.issuer_research_id
        and r.user_id = public.user_company_research_decisions.user_id
        and r.cik = public.user_company_research_decisions.cik
    )
  );
create policy company_follows_select_own on public.user_company_follows
  for select to authenticated using (user_id = (select auth.uid()));
create policy company_follows_insert_own on public.user_company_follows
  for insert to authenticated with check (
    public.user_company_follows.user_id = (select auth.uid())
    and exists (
      select 1 from public.user_research_issuers r
      where r.id = public.user_company_follows.issuer_research_id
        and r.user_id = public.user_company_follows.user_id
        and r.cik = public.user_company_follows.cik
    )
  );
create policy company_follows_unfollow_own on public.user_company_follows
  for update to authenticated using (
    user_id = (select auth.uid()) and unfollowed_at is null
  ) with check (
    user_id = (select auth.uid()) and unfollowed_at is not null
  );
create policy followed_baselines_select_own on public.user_followed_evidence_baselines
  for select to authenticated using (user_id = (select auth.uid()));
create policy followed_baselines_insert_own on public.user_followed_evidence_baselines
  for insert to authenticated with check (
    public.user_followed_evidence_baselines.user_id = (select auth.uid())
    and exists (
      select 1 from public.user_company_follows f
      where f.id = public.user_followed_evidence_baselines.follow_id
        and f.user_id = public.user_followed_evidence_baselines.user_id
        and f.cik = public.user_followed_evidence_baselines.cik
        and f.unfollowed_at is null
    )
  );

create function public.stamp_user_company_unfollow()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.unfollowed_at is not null or new.unfollowed_at is null
    or new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.cik is distinct from old.cik
    or new.issuer_research_id is distinct from old.issuer_research_id
    or new.created_at is distinct from old.created_at then
    raise exception 'follow_state_transition_invalid' using errcode = '23514';
  end if;
  new.unfollowed_at := clock_timestamp();
  return new;
end;
$$;

create trigger user_company_follow_unfollow_stamp
  before update on public.user_company_follows
  for each row execute function public.stamp_user_company_unfollow();
revoke all on function public.stamp_user_company_unfollow() from public, anon, authenticated;

-- Archive only the caller's active follow. The timestamp is assigned in the
-- database, while authenticated clients retain no direct UPDATE privilege.
create function public.unfollow_user_company_follow(p_follow_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  archived_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  update public.user_company_follows f
    set unfollowed_at = clock_timestamp()
    where f.id = p_follow_id
      and f.user_id = auth.uid()
      and f.unfollowed_at is null
    returning f.unfollowed_at into archived_at;
  if archived_at is null then
    raise exception 'follow_not_found' using errcode = 'P0002';
  end if;
  return archived_at;
end;
$$;

revoke all on function public.unfollow_user_company_follow(uuid) from public, anon;
grant execute on function public.unfollow_user_company_follow(uuid) to authenticated;

-- Reject evidence IDs that are missing or belong to another CIK/snapshot.
create function public.validate_company_research_decision_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  companyfacts_digest text;
  submissions_digest text;
  facts_snapshot_completed_at timestamptz;
  submissions_snapshot_completed_at timestamptz;
  normalized_fact_ids text;
  normalized_filing_ids text;
begin
  select s.source_response_sha256, s.completed_at
    into companyfacts_digest, facts_snapshot_completed_at
  from public.sec_companyfacts_snapshots s
  join public.core_source_runs r on r.id = s.source_run_id
  where s.id = new.companyfacts_snapshot_id and s.cik = new.cik
    and r.status = 'success' and s.completed_at is not null;
  if companyfacts_digest is null or facts_snapshot_completed_at is null
    or new.as_of > facts_snapshot_completed_at or new.as_of > clock_timestamp() then
    raise exception 'research_decision_companyfacts_snapshot_unavailable' using errcode = '23514';
  end if;

  if cardinality(new.evidence_fact_ids) > 0 and (
    select count(*) from public.sec_company_fact_values f
    where f.id = any(new.evidence_fact_ids)
      and f.cik = new.cik
      and f.snapshot_id = new.companyfacts_snapshot_id
  ) <> cardinality(new.evidence_fact_ids) then
    raise exception 'research_decision_fact_identity_mismatch' using errcode = '23514';
  end if;

  if cardinality(new.evidence_filing_ids) > 0 and (
    new.submissions_snapshot_id is null or
    (select count(*) from public.sec_filing_observations f
     where f.id = any(new.evidence_filing_ids)
       and f.cik = new.cik
       and f.snapshot_id = new.submissions_snapshot_id)
      <> cardinality(new.evidence_filing_ids)
  ) then
    raise exception 'research_decision_filing_identity_mismatch' using errcode = '23514';
  end if;

  if new.submissions_snapshot_id is not null then
    select s.source_response_sha256, s.completed_at
      into submissions_digest, submissions_snapshot_completed_at
    from public.sec_submissions_snapshots s
    join public.core_source_runs r on r.id = s.source_run_id
    where s.id = new.submissions_snapshot_id and s.cik = new.cik
      and r.status = 'success' and s.completed_at is not null;
    if submissions_digest is null or submissions_snapshot_completed_at is null then
      raise exception 'research_decision_submissions_snapshot_unavailable' using errcode = '23514';
    end if;
  end if;
  select coalesce(string_agg(ids.id::text, ',' order by ids.id::text), '') into normalized_fact_ids
  from unnest(new.evidence_fact_ids) as ids(id);
  select coalesce(string_agg(ids.id::text, ',' order by ids.id::text), '') into normalized_filing_ids
  from unnest(new.evidence_filing_ids) as ids(id);
  new.evidence_digest := encode(
    extensions.digest(
      convert_to(concat_ws('|', 'sec-company-research-decision/v1', new.cik,
        new.companyfacts_snapshot_id::text, companyfacts_digest,
        coalesce(new.submissions_snapshot_id::text, ''), coalesce(submissions_digest, ''),
        normalized_fact_ids, normalized_filing_ids, new.as_of::text), 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

create trigger company_research_decision_evidence_guard
  before insert on public.user_company_research_decisions
  for each row execute function public.validate_company_research_decision_evidence();
revoke all on function public.validate_company_research_decision_evidence() from public, anon, authenticated;

-- Baseline references are versioned and source-ID exact. Capture clients must
-- calculate the digest from the returned, bounded filing-ID set.
create function public.validate_follow_baseline_filings()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  latest_baseline_id uuid;
  latest_version integer;
  current_snapshot_id uuid;
  source_digest text;
  normalized_ids text;
  exact_filing_ids uuid[];
begin
  select b.id, b.version into latest_baseline_id, latest_version
  from public.user_followed_evidence_baselines b
  where b.follow_id = new.follow_id
  order by b.version desc limit 1;
  if latest_baseline_id is distinct from new.expected_previous_baseline_id then
    raise exception 'follow_baseline_stale_expected_version' using errcode = '40001';
  end if;

  select h.snapshot_id into current_snapshot_id
  from public.sec_submissions_head h where h.cik = new.cik;
  if current_snapshot_id is null or current_snapshot_id <> new.snapshot_id then
    raise exception 'follow_baseline_snapshot_not_current' using errcode = '23514';
  end if;

  select s.source_response_sha256 into source_digest
  from public.sec_submissions_snapshots s
  join public.core_source_runs r on r.id = s.source_run_id
  where s.id = new.snapshot_id and s.cik = new.cik and r.status in ('success', 'partial');
  if source_digest is null then
    raise exception 'follow_baseline_source_receipt_unavailable' using errcode = '23514';
  end if;

  select coalesce(array_agg(f.id order by f.id), '{}'::uuid[]) into exact_filing_ids
  from public.sec_filing_observations f
  where f.cik = new.cik and f.snapshot_id = new.snapshot_id;
  if cardinality(exact_filing_ids) > 50000 then
    raise exception 'follow_baseline_evidence_limit_exceeded' using errcode = '54000';
  end if;
  new.filing_ids := exact_filing_ids;
  select coalesce(string_agg(ids.id::text, ',' order by ids.id::text), '') into normalized_ids
  from unnest(exact_filing_ids) as ids(id);
  new.version := coalesce(latest_version, 0) + 1;
  new.captured_at := clock_timestamp();
  new.evidence_digest := encode(
    extensions.digest(
      convert_to(concat_ws('|', 'sec-follow-baseline/v1', new.cik, new.snapshot_id::text, source_digest, normalized_ids), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$;

create trigger followed_baseline_filing_guard
  before insert on public.user_followed_evidence_baselines
  for each row execute function public.validate_follow_baseline_filings();
revoke all on function public.validate_follow_baseline_filings() from public, anon, authenticated;

create function public.capture_user_followed_evidence_baseline(
  p_follow_id uuid,
  p_capture_key uuid,
  p_expected_previous_baseline_id uuid default null
)
returns public.user_followed_evidence_baselines
language plpgsql
security invoker
set search_path = ''
as $$
declare
  follow_cik text;
  current_snapshot_id uuid;
  latest_baseline_id uuid;
  captured public.user_followed_evidence_baselines;
begin
  if auth.uid() is null or p_capture_key is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  select f.cik into follow_cik
    from public.user_company_follows f
    where f.id = p_follow_id and f.user_id = auth.uid() and f.unfollowed_at is null;
  if follow_cik is null then
    raise exception 'follow_not_found' using errcode = 'P0002';
  end if;
  select b.id into latest_baseline_id
    from public.user_followed_evidence_baselines b
    where b.follow_id = p_follow_id
    order by b.version desc limit 1;
  if latest_baseline_id is distinct from p_expected_previous_baseline_id then
    raise exception 'follow_baseline_stale_expected_version' using errcode = '40001';
  end if;
  select h.snapshot_id into current_snapshot_id
    from public.sec_submissions_head h where h.cik = follow_cik;
  if current_snapshot_id is null then
    raise exception 'followed_company_source_unavailable' using errcode = '55000';
  end if;
  insert into public.user_followed_evidence_baselines (
    user_id, follow_id, cik, snapshot_id, capture_key, expected_previous_baseline_id, version
  ) values (
    auth.uid(), p_follow_id, follow_cik, current_snapshot_id, p_capture_key, p_expected_previous_baseline_id, 0
  ) returning * into captured;
  return captured;
end;
$$;

revoke all on function public.capture_user_followed_evidence_baseline(uuid, uuid, uuid) from public, anon;
grant execute on function public.capture_user_followed_evidence_baseline(uuid, uuid, uuid) to authenticated;

-- Compare the entire captured source snapshot by stable SEC accession. The
-- browser receives only the bounded review list, never a truncated ID prefix.
create function public.read_user_followed_filing_changes(p_follow_id uuid)
returns table (
  snapshot_id uuid,
  snapshot_retrieved_at timestamptz,
  snapshot_completed_at timestamptz,
  snapshot_filing_count integer,
  snapshot_source_response_sha256 text,
  baseline_id uuid,
  baseline_snapshot_id uuid,
  baseline_capture_key uuid,
  baseline_version integer,
  baseline_captured_at timestamptz,
  baseline_filing_count integer,
  baseline_evidence_digest text,
  new_filing_count bigint,
  omitted_filing_count bigint,
  new_filings jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_follow as (
    select f.cik
    from public.user_company_follows f
    where f.id = p_follow_id
      and f.user_id = (select auth.uid())
      and f.unfollowed_at is null
  ), latest_baseline as (
    select b.id, b.snapshot_id, b.capture_key, b.version, b.captured_at,
      b.filing_count, b.evidence_digest, b.filing_ids
    from public.user_followed_evidence_baselines b
    where b.follow_id = p_follow_id and b.user_id = (select auth.uid())
    order by b.version desc
    limit 1
  ), current_snapshot as (
    select h.snapshot_id, f.cik, s.retrieved_at, s.completed_at,
      s.filing_count, s.source_response_sha256
    from selected_follow f
    left join public.sec_submissions_head h on h.cik = f.cik
    left join public.sec_submissions_snapshots s on s.id = h.snapshot_id and s.cik = f.cik
  ), new_filings as (
    select current_filing.id, current_filing.cik, current_filing.accession,
      current_filing.form, current_filing.filed_at, current_filing.report_period,
      current_filing.accepted_at, current_filing.primary_document,
      current_filing.source_url, current_filing.retrieved_at
    from current_snapshot current
    join public.sec_filing_observations current_filing
      on current_filing.snapshot_id = current.snapshot_id and current_filing.cik = current.cik
    left join latest_baseline baseline on true
    where not exists (
      select 1
      from unnest(coalesce(baseline.filing_ids, '{}'::uuid[])) as baseline_id(id)
      join public.sec_filing_observations prior_filing on prior_filing.id = baseline_id.id
      where prior_filing.accession = current_filing.accession
    )
  ), ranked_new_filings as (
    select filing.*, row_number() over (order by filing.filed_at desc, filing.accession desc) as position
    from new_filings filing
  ), change_summary as (
    select count(*)::bigint as total_count,
      coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'cik', cik,
        'accession', accession,
        'form', form,
        'filed_at', filed_at,
        'report_period', report_period,
        'accepted_at', accepted_at,
        'primary_document', primary_document,
        'source_url', source_url,
        'retrieved_at', retrieved_at
      ) order by filed_at desc, accession desc) filter (where position <= 50), '[]'::jsonb) as filings
    from ranked_new_filings
  )
  select current.snapshot_id, current.retrieved_at, current.completed_at, current.filing_count,
    current.source_response_sha256, baseline.id, baseline.snapshot_id, baseline.capture_key,
    baseline.version, baseline.captured_at, baseline.filing_count, baseline.evidence_digest,
    changes.total_count, greatest(changes.total_count - 50, 0), changes.filings
  from selected_follow follow
  join current_snapshot current on true
  left join latest_baseline baseline on true
  cross join change_summary changes;
$$;

revoke all on function public.read_user_followed_filing_changes(uuid) from public, anon;
grant execute on function public.read_user_followed_filing_changes(uuid) to authenticated;

-- Search runs under the authenticated caller's role and remains bounded to the
-- currently published issuer snapshot. It does not imply size or merit.
create function public.search_sec_issuer_directory(query_text text, max_results integer default 50)
returns table (
  snapshot_id uuid,
  cik text,
  ticker text,
  issuer_name text,
  exchange text,
  retrieved_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  normalized_query text := btrim(coalesce(query_text, ''));
  bounded_limit integer := least(greatest(coalesce(max_results, 50), 1), 50);
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if length(normalized_query) < 2 or length(normalized_query) > 120 or normalized_query ~ '[%_[:cntrl:]]' then
    raise exception 'issuer_search_query_out_of_range' using errcode = '22023';
  end if;

  return query
  select e.snapshot_id, e.cik, e.ticker, e.issuer_name, e.exchange, s.retrieved_at
  from public.sec_issuer_directory_entries e
  join public.sec_issuer_directory_head h
    on h.dataset = 'company_tickers_exchange' and h.snapshot_id = e.snapshot_id
  join public.sec_issuer_directory_snapshots s on s.id = e.snapshot_id
  where e.ticker = upper(normalized_query)
     or e.cik = lpad(normalized_query, 10, '0')
     or e.ticker ilike normalized_query || '%'
     or e.issuer_name ilike '%' || normalized_query || '%'
  order by
    case when e.ticker = upper(normalized_query) or e.cik = lpad(normalized_query, 10, '0') then 0
         when e.ticker ilike normalized_query || '%' then 1 else 2 end,
    e.issuer_name,
    e.cik
  limit bounded_limit;
end;
$$;

revoke all on function public.search_sec_issuer_directory(text, integer) from public, anon;
grant execute on function public.search_sec_issuer_directory(text, integer) to authenticated;

-- Publication is a one-step head switch after all normalized rows are durable.
create function public.publish_sec_issuer_directory_snapshot(p_snapshot_id uuid, p_expected_rows integer)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  snapshot_row public.sec_issuer_directory_snapshots;
  run_started_at timestamptz;
  run_status text;
  publication_at timestamptz;
  actual_rows integer;
begin
  select s.* into snapshot_row from public.sec_issuer_directory_snapshots s
    where s.id = p_snapshot_id for update;
  if snapshot_row.id is null or snapshot_row.completed_at is not null then
    raise exception 'issuer_snapshot_missing_or_already_published' using errcode = '23514';
  end if;
  select r.started_at, r.status into run_started_at, run_status
    from public.core_source_runs r where r.id = snapshot_row.source_run_id for update;
  if run_status is null then
    raise exception 'issuer_snapshot_source_run_missing' using errcode = '23514';
  end if;
  select count(*)::integer into actual_rows
    from public.sec_issuer_directory_entries e where e.snapshot_id = p_snapshot_id;
  if run_status <> 'running' or p_expected_rows < 1 or actual_rows <> p_expected_rows
    or snapshot_row.source_id <> 'sec_company_tickers_exchange'
    or snapshot_row.row_count <> p_expected_rows
    or snapshot_row.retrieved_at < run_started_at
    or snapshot_row.retrieved_at > clock_timestamp()
    or not exists (
      select 1 from public.core_source_runs r
      where r.id = snapshot_row.source_run_id
        and r.source_id = 'sec_company_tickers_exchange'
        and r.row_count = p_expected_rows
        and r.response_sha256 = snapshot_row.source_response_sha256
        and r.retrieved_at = snapshot_row.retrieved_at
    ) then
    raise exception 'issuer_snapshot_row_count_mismatch' using errcode = '23514';
  end if;
  publication_at := clock_timestamp();
  if snapshot_row.retrieved_at > publication_at then
    raise exception 'issuer_snapshot_retrieval_time_invalid' using errcode = '23514';
  end if;
  update public.sec_issuer_directory_snapshots set completed_at = publication_at where id = p_snapshot_id;
  update public.core_source_runs set status = 'success', completed_at = publication_at, failure_code = null
    where id = snapshot_row.source_run_id and status = 'running';
  insert into public.sec_issuer_directory_head(dataset, snapshot_id, updated_at)
  values ('company_tickers_exchange', p_snapshot_id, publication_at)
  on conflict (dataset) do update
    set snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.publish_sec_issuer_directory_snapshot(uuid, integer) from public, anon, authenticated;
grant execute on function public.publish_sec_issuer_directory_snapshot(uuid, integer) to service_role;

create function public.publish_sec_companyfacts_snapshot(p_snapshot_id uuid, p_expected_facts integer)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  snapshot_row public.sec_companyfacts_snapshots;
  run_started_at timestamptz;
  run_status text;
  publication_at timestamptz;
  actual_facts integer;
begin
  select s.* into snapshot_row from public.sec_companyfacts_snapshots s where s.id = p_snapshot_id for update;
  if snapshot_row.id is null or snapshot_row.completed_at is not null
    or p_expected_facts < 0 or snapshot_row.fact_count <> p_expected_facts then
    raise exception 'companyfacts_snapshot_missing_or_count_mismatch' using errcode = '23514';
  end if;
  select r.started_at, r.status into run_started_at, run_status
    from public.core_source_runs r where r.id = snapshot_row.source_run_id for update;
  if run_status is null then
    raise exception 'companyfacts_snapshot_source_run_missing' using errcode = '23514';
  end if;
  select count(*)::integer into actual_facts from public.sec_company_fact_values f where f.snapshot_id = p_snapshot_id;
  if actual_facts <> p_expected_facts or run_status <> 'running'
    or snapshot_row.retrieved_at < run_started_at or snapshot_row.retrieved_at > clock_timestamp()
    or not exists (
    select 1 from public.core_source_runs r
    where r.id = snapshot_row.source_run_id
      and r.source_id = 'sec_companyfacts'
      and r.source_url = snapshot_row.source_url
      and r.status = 'running'
      and r.response_sha256 = snapshot_row.source_response_sha256
      and r.row_count = p_expected_facts
      and r.retrieved_at = snapshot_row.retrieved_at
  ) then
    raise exception 'companyfacts_snapshot_receipt_mismatch' using errcode = '23514';
  end if;
  publication_at := clock_timestamp();
  if snapshot_row.retrieved_at > publication_at then
    raise exception 'companyfacts_snapshot_retrieval_time_invalid' using errcode = '23514';
  end if;
  update public.sec_companyfacts_snapshots set completed_at = publication_at where id = p_snapshot_id;
  update public.core_source_runs set status = 'success', completed_at = publication_at, failure_code = null
    where id = snapshot_row.source_run_id and status = 'running';
  insert into public.sec_companyfacts_head(cik, snapshot_id, updated_at)
    values (snapshot_row.cik, p_snapshot_id, publication_at)
    on conflict (cik) do update set snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at;
end;
$$;

create function public.publish_sec_submissions_snapshot(p_snapshot_id uuid, p_expected_filings integer)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  snapshot_row public.sec_submissions_snapshots;
  run_started_at timestamptz;
  run_status text;
  publication_at timestamptz;
  actual_filings integer;
begin
  select s.* into snapshot_row from public.sec_submissions_snapshots s where s.id = p_snapshot_id for update;
  if snapshot_row.id is null or snapshot_row.completed_at is not null
    or p_expected_filings < 0 or snapshot_row.filing_count <> p_expected_filings then
    raise exception 'submissions_snapshot_missing_or_count_mismatch' using errcode = '23514';
  end if;
  select r.started_at, r.status into run_started_at, run_status
    from public.core_source_runs r where r.id = snapshot_row.source_run_id for update;
  if run_status is null then
    raise exception 'submissions_snapshot_source_run_missing' using errcode = '23514';
  end if;
  select count(*)::integer into actual_filings from public.sec_filing_observations f where f.snapshot_id = p_snapshot_id;
  if actual_filings <> p_expected_filings or run_status <> 'running'
    or snapshot_row.retrieved_at < run_started_at or snapshot_row.retrieved_at > clock_timestamp()
    or not exists (
    select 1 from public.core_source_runs r
    where r.id = snapshot_row.source_run_id
      and r.source_id = 'sec_submissions'
      and r.source_url = snapshot_row.source_url
      and r.status = 'running'
      and r.response_sha256 = snapshot_row.source_response_sha256
      and r.row_count = p_expected_filings
      and r.retrieved_at = snapshot_row.retrieved_at
  ) then
    raise exception 'submissions_snapshot_receipt_mismatch' using errcode = '23514';
  end if;
  publication_at := clock_timestamp();
  if snapshot_row.retrieved_at > publication_at then
    raise exception 'submissions_snapshot_retrieval_time_invalid' using errcode = '23514';
  end if;
  update public.sec_submissions_snapshots set completed_at = publication_at where id = p_snapshot_id;
  update public.core_source_runs set status = 'success', completed_at = publication_at, failure_code = null
    where id = snapshot_row.source_run_id and status = 'running';
  insert into public.sec_submissions_head(cik, snapshot_id, updated_at)
    values (snapshot_row.cik, p_snapshot_id, publication_at)
    on conflict (cik) do update set snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.publish_sec_companyfacts_snapshot(uuid, integer) from public, anon, authenticated;
revoke all on function public.publish_sec_submissions_snapshot(uuid, integer) from public, anon, authenticated;
grant execute on function public.publish_sec_companyfacts_snapshot(uuid, integer) to service_role;
grant execute on function public.publish_sec_submissions_snapshot(uuid, integer) to service_role;

create function public.cleanup_sec_issuer_directory_history()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  removed integer := 0;
  changed integer;
begin
  delete from public.sec_source_payloads p
  using public.core_source_runs r
  where p.source_run_id = r.id
    and r.source_id = 'sec_company_tickers_exchange'
    and r.created_at < clock_timestamp() - interval '30 days';
  get diagnostics changed = row_count;
  removed := removed + changed;

  delete from public.sec_issuer_directory_entries e
  using public.sec_issuer_directory_snapshots s
  where e.snapshot_id = s.id
    and s.created_at < clock_timestamp() - interval '90 days'
    and not exists (
      select 1 from public.sec_issuer_directory_head h
      where h.snapshot_id = s.id
    )
    and not exists (
      select 1 from public.user_research_issuers u
      where u.selected_snapshot_id = s.id
    );
  get diagnostics changed = row_count;
  removed := removed + changed;

  delete from public.sec_issuer_directory_snapshots s
  where s.created_at < clock_timestamp() - interval '90 days'
    and not exists (
      select 1 from public.sec_issuer_directory_head h
      where h.snapshot_id = s.id
    )
    and not exists (
      select 1 from public.user_research_issuers u
      where u.selected_snapshot_id = s.id
    );
  get diagnostics changed = row_count;
  return removed + changed;
end;
$$;

revoke all on function public.cleanup_sec_issuer_directory_history() from public, anon, authenticated;
grant execute on function public.cleanup_sec_issuer_directory_history() to service_role;

create function public.cleanup_sec_company_evidence_history()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  removed integer := 0;
  changed integer;
begin
  delete from public.sec_company_fact_values f
  using public.sec_companyfacts_snapshots s
  where f.snapshot_id = s.id
    and s.created_at < clock_timestamp() - interval '90 days'
    and not exists (select 1 from public.sec_companyfacts_head h where h.snapshot_id = s.id)
    and not exists (select 1 from public.user_company_research_decisions d where d.companyfacts_snapshot_id = s.id);
  get diagnostics changed = row_count;
  removed := removed + changed;

  delete from public.sec_companyfacts_snapshots s
  where s.created_at < clock_timestamp() - interval '90 days'
    and not exists (select 1 from public.sec_companyfacts_head h where h.snapshot_id = s.id)
    and not exists (select 1 from public.user_company_research_decisions d where d.companyfacts_snapshot_id = s.id);
  get diagnostics changed = row_count;
  removed := removed + changed;

  delete from public.sec_filing_observations f
  using public.sec_submissions_snapshots s
  where f.snapshot_id = s.id
    and s.created_at < clock_timestamp() - interval '90 days'
    and not exists (select 1 from public.sec_submissions_head h where h.snapshot_id = s.id)
    and not exists (select 1 from public.user_company_research_decisions d where d.submissions_snapshot_id = s.id)
    and not exists (select 1 from public.user_followed_evidence_baselines b where b.snapshot_id = s.id);
  get diagnostics changed = row_count;
  removed := removed + changed;

  delete from public.sec_submissions_snapshots s
  where s.created_at < clock_timestamp() - interval '90 days'
    and not exists (select 1 from public.sec_submissions_head h where h.snapshot_id = s.id)
    and not exists (select 1 from public.user_company_research_decisions d where d.submissions_snapshot_id = s.id)
    and not exists (select 1 from public.user_followed_evidence_baselines b where b.snapshot_id = s.id);
  get diagnostics changed = row_count;
  removed := removed + changed;

  delete from public.core_source_runs r
  where r.source_id in ('sec_companyfacts', 'sec_submissions')
    and r.created_at < clock_timestamp() - interval '90 days'
    and not exists (select 1 from public.sec_companyfacts_snapshots s where s.source_run_id = r.id)
    and not exists (select 1 from public.sec_submissions_snapshots s where s.source_run_id = r.id);
  get diagnostics changed = row_count;
  return removed + changed;
end;
$$;

revoke all on function public.cleanup_sec_company_evidence_history() from public, anon, authenticated;
grant execute on function public.cleanup_sec_company_evidence_history() to service_role;

-- Source ingest writes are server-only. User-owned work is append-only through
-- this hosted workflow; deletion and account export need their own explicit path.
revoke update on public.user_research_issuers from authenticated;
revoke update, delete on public.user_company_research_decisions from authenticated;
revoke update on public.user_company_follows from authenticated;
revoke update, delete on public.user_followed_evidence_baselines from authenticated;

