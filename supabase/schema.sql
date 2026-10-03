-- =====================================================================
--  AlmaED outreach - Supabase database
--  Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
--  It is safe to run again: it only creates what is missing.
--
--  LAST LINE: replace you@example.com with the email you will log in
--  to the dashboard with. Only emails in public.admins can see the data.
-- =====================================================================

-- ---------- who may use the dashboard ----------
create table if not exists public.admins (
  email text primary key
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------- contacts (one row per WhatsApp number) ----------
create table if not exists public.contacts (
  phone              text primary key,               -- e.g. 919876543210
  seq                bigint generated always as identity,
  name               text,
  first              text,
  region             text,
  email              text,
  status             text not null default 'pending'
                     check (status in ('pending','skipped','sent','replied','interested',
                                       'details_sent','not_interested','not_on_whatsapp')),
  skip_reason        text,
  sent_at            timestamptz,
  message_id         text,
  pending_details_at timestamptz,
  details_at         timestamptz,
  needs_you          boolean not null default false,
  last_reply         text,
  last_reply_at      timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists contacts_status_seq on public.contacts (status, seq);
create index if not exists contacts_sent_at on public.contacts (sent_at);
create index if not exists contacts_details_due on public.contacts (pending_details_at) where pending_details_at is not null;
create index if not exists contacts_message_id on public.contacts (message_id);
create index if not exists contacts_needs_you on public.contacts (needs_you) where needs_you;

-- ---------- conversation history ----------
create table if not exists public.messages (
  id        bigint generated always as identity primary key,
  phone     text not null references public.contacts(phone) on delete cascade,
  direction text not null check (direction in ('us','them')),
  body      text,
  at        timestamptz not null default now()
);
create index if not exists messages_phone_at on public.messages (phone, at);

-- ---------- activity feed ----------
create table if not exists public.activity (
  id   bigint generated always as identity primary key,
  at   timestamptz not null default now(),
  kind text not null default 'info',
  text text
);
create index if not exists activity_at on public.activity (at desc);

-- ---------- settings (single row) ----------
create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  running               boolean not null default false,
  daily_limit           int not null default 50 check (daily_limit between 1 and 500),
  warmup                int[] not null default '{15,25,35}',
  send_from_hour        int not null default 10 check (send_from_hour between 0 and 23),
  send_until_hour       int not null default 19 check (send_until_hour between 1 and 24),
  min_gap_seconds       int not null default 90,
  max_gap_seconds       int not null default 240,
  details_delay_seconds int[] not null default '{20,60}',
  typing_indicator      boolean not null default true,
  timezone              text not null default 'Asia/Kolkata',
  test_number           text not null default '',
  opener                text not null default $msg$[[Hi|Hello]] {first}, [[hope you're doing well!|hope all is well!|I hope you're doing well!]]

I'm Kesav, a fourth-year student at IIT Kharagpur. A few of us from IITs, NITs and AIIMS have started AlmaED to mentor school and college students 1-on-1 in Physics, Chemistry, Maths and Biology, for boards, JEE and NEET.

Do you have a child in school or college, or know a family looking for a good mentor? I'd be glad to share details and a free demo slot.

Our 1-min film: https://www.youtube.com/shorts/us1mpFiuR2g
AlmaED: https://www.linkedin.com/company/almaed/
Me: https://www.linkedin.com/in/kesav-krishna-k/

[[Thank you!|Thanks a lot!|Thank you so much!]]$msg$,
  details               text not null default $msg$Thank you, {first}! Here's a quick overview of *AlmaED*:

• One student, one dedicated mentor from IIT, NIT or AIIMS
• A personal study plan, assignments, regular tests and doubt-solving
• Flexible timings, with progress updates for parents
• Physics, Chemistry, Maths and Biology, from board exams to JEE and NEET, for students in India and abroad

Children of professors from IIT Madras, IIT Guwahati and IIT Bhubaneswar are learning with us right now.

You can book a *free 30-minute demo* here, and parents are welcome to sit in: https://calendar.app.google/SUAnzMcYiJitqbpx5

If you know anyone else whose child could benefit, please feel free to forward this. Thank you!$msg$,
  not_interested_reply  text not null default '',
  days_active           text[] not null default '{}',
  next_send_at          timestamptz,
  consecutive_errors    int not null default 0,
  last_error            text not null default '',
  updated_at            timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------- jobs the dashboard asks the sender to do ----------
create table if not exists public.commands (
  id         bigint generated always as identity primary key,
  type       text not null check (type in ('login','paircode','test','reply','restartgowa')),
  payload    jsonb not null default '{}',
  status     text not null default 'queued' check (status in ('queued','running','done','failed')),
  result     jsonb,
  error      text,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists commands_queued on public.commands (status, id) where status = 'queued';

-- ---------- what the sender reports (single row) ----------
create table if not exists public.worker_status (
  id             int primary key default 1 check (id = 1),
  instance_id    text,
  heartbeat_at   timestamptz,
  gowa_reachable boolean not null default false,
  logged_in      boolean not null default false,
  number         text,
  proc_state     text,
  proc_reason    text,
  proc_tail      text,
  qr_png         text,          -- base64 PNG, only while a login is in progress
  qr_until       timestamptz,
  version        text,
  platform       text
);
alter table public.worker_status add column if not exists platform text;
insert into public.worker_status (id) values (1) on conflict (id) do nothing;

-- ---------- views for the dashboard ----------
create or replace view public.contact_counts with (security_invoker = true) as
  select status, count(*)::int as n from public.contacts group by status;

-- ---------- security: only admins (and the sender's secret key) ----------
alter table public.admins        enable row level security;
alter table public.contacts      enable row level security;
alter table public.messages      enable row level security;
alter table public.activity      enable row level security;
alter table public.settings      enable row level security;
alter table public.commands      enable row level security;
alter table public.worker_status enable row level security;

do $$
declare t text;
begin
  foreach t in array array['contacts','messages','activity','settings','commands','worker_status'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
drop policy if exists admin_read_self on public.admins;
create policy admin_read_self on public.admins for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on function public.is_admin() to authenticated;

-- ---------- CHANGE THIS to the email you log in with ----------
insert into public.admins (email) values ('you@example.com') on conflict do nothing;
