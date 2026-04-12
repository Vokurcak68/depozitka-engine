-- Support tickets (public intake via engine API) + attachments

create table if not exists dpt_support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no bigint generated always as identity,
  status text not null default 'draft',

  email text,
  name text,
  category text,
  subject text,
  message text,
  page_url text,
  transaction_ref text,

  ip_hash text,
  user_agent text,

  -- protects the attachment upload URL endpoint from abuse after the initial Turnstile check
  upload_token_hash text,
  upload_token_expires_at timestamptz,

  submitted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dpt_support_tickets_status_chk check (status in ('draft','open','closed','spam'))
);

create unique index if not exists idx_dpt_support_tickets_ticket_no on dpt_support_tickets(ticket_no);
create index if not exists idx_dpt_support_tickets_created_at on dpt_support_tickets(created_at desc);
create index if not exists idx_dpt_support_tickets_ip_hash_created_at on dpt_support_tickets(ip_hash, created_at desc);

create table if not exists dpt_support_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references dpt_support_tickets(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  content_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

create index if not exists idx_dpt_support_attachments_ticket_id on dpt_support_attachments(ticket_id);

-- updated_at triggers
create trigger trg_dpt_support_tickets_updated_at
before update on dpt_support_tickets
for each row execute function dpt_set_updated_at();

-- RLS (defensive: public must not read/write directly; engine uses service role)
alter table dpt_support_tickets enable row level security;
alter table dpt_support_attachments enable row level security;

-- Storage bucket for attachments (private)
insert into storage.buckets (id, name, public)
values ('dpt-support-attachments', 'dpt-support-attachments', false)
on conflict (id) do nothing;
