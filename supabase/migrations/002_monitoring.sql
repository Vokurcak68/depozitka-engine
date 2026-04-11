-- Monitoring: targets, checks, incidents

create table if not exists dpt_monitor_targets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  url text not null,
  method text not null default 'GET',
  timeout_ms integer not null default 10000,
  expected_statuses integer[] not null default array[200],
  enabled boolean not null default true,
  severity text not null default 'critical',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dpt_monitor_targets_severity_chk check (severity in ('critical', 'high', 'low'))
);

create index if not exists idx_dpt_monitor_targets_enabled on dpt_monitor_targets(enabled);

create table if not exists dpt_monitor_checks (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references dpt_monitor_targets(id) on delete cascade,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  status_code integer,
  response_ms integer,
  error_message text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists idx_dpt_monitor_checks_target_checked_at on dpt_monitor_checks(target_id, checked_at desc);
create index if not exists idx_dpt_monitor_checks_checked_at on dpt_monitor_checks(checked_at desc);

create table if not exists dpt_monitor_incidents (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references dpt_monitor_targets(id) on delete cascade,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  open_reason text,
  close_reason text,
  opened_check_id uuid references dpt_monitor_checks(id) on delete set null,
  closed_check_id uuid references dpt_monitor_checks(id) on delete set null,
  notifications_sent integer not null default 0,
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dpt_monitor_incidents_status_chk check (status in ('open', 'closed'))
);

create index if not exists idx_dpt_monitor_incidents_target_status on dpt_monitor_incidents(target_id, status);
create index if not exists idx_dpt_monitor_incidents_opened_at on dpt_monitor_incidents(opened_at desc);

create or replace function dpt_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_dpt_monitor_targets_updated_at on dpt_monitor_targets;
create trigger trg_dpt_monitor_targets_updated_at
before update on dpt_monitor_targets
for each row execute function dpt_set_updated_at();

drop trigger if exists trg_dpt_monitor_incidents_updated_at on dpt_monitor_incidents;
create trigger trg_dpt_monitor_incidents_updated_at
before update on dpt_monitor_incidents
for each row execute function dpt_set_updated_at();

insert into dpt_monitor_targets (code, name, url, expected_statuses, severity)
values
  ('core-root', 'Depozitka Core /', 'https://core.depozitka.eu/', array[200], 'critical'),
  ('engine-root', 'Depozitka Engine /', 'https://depozitka-engine.vercel.app/', array[200], 'critical')
on conflict (code) do nothing;
