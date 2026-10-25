-- ===========================================================================
-- 0005_system_config.sql
--
-- Schema version, deployment version and the handful of operational switches
-- the application reads at runtime.
--
-- WHAT IS DELIBERATELY NOT HERE: the Google Sheets spreadsheet ID.
--
-- It is an Edge Function secret named SHEETS_SPREADSHEET_ID with NO default
-- value, and the sync worker refuses to run when it is unset. Putting it in a
-- database row readable by the application would make it a configuration value
-- that an operator could point at the uploaded DRAFT workbook, which must
-- never be written to. The row below records only WHERE the identifier lives,
-- so a reader of this schema is not left guessing.
-- ===========================================================================

create table public.system_config (
  key         text primary key,
  value       text,
  description text not null,
  -- False for a value the application only reads. True for a switch an
  -- administrator may change through the admin screen.
  operator_editable boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),

  constraint system_config_key_shape check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint system_config_description_present check (length(btrim(description)) > 0)
);

create trigger system_config_set_updated_at
  before update on public.system_config
  for each row execute function public.tg_set_updated_at();

insert into public.system_config (key, value, description, operator_editable) values
  ('schema_version', '0005',
   'Highest applied migration number. Updated by the last migration in a release.', false),

  ('deployment_version', 'local-dev',
   'Build identity stamped onto audit events and assessments so a behaviour change can be attributed. CI sets this to the commit SHA.', false),

  -- Master Prompt section 7: "If business rules require Google Sheets
  -- confirmation before authorizing material release ... enforce it as a
  -- gate." Off until Bounty Farm decides, because switching it on with an
  -- unreliable sync would block every release.
  ('require_sheet_confirmation', 'false',
   'When true, a sample whose operational row is not yet confirmed in Google Sheets cannot be released. Blocks evaluateRelease() with sheet_sync_unconfirmed.', true),

  ('sheet_sync_enabled', 'false',
   'Master switch for the outbox worker. Stays false until a controlled TEST copy of the workbook has been verified. The uploaded draft is never a write target.', true),

  ('sheet_sync_max_attempts', '8',
   'Attempts before an outbox event moves to dead_letter and becomes a visible needs-attention item.', true),

  ('sheet_sync_lease_seconds', '120',
   'How long a sync worker may hold the single-writer lease before it is considered dead and the lease may be taken over with a higher fence token.', true),

  ('sheets_spreadsheet_id_location', 'edge_function_secret:SHEETS_SPREADSHEET_ID',
   'Documentation only. The spreadsheet ID is never stored in the database or shipped to the browser; it is an Edge Function secret with no default, and the worker refuses to run when it is unset.', false),

  ('sampling_frequency_kpi_enabled', 'false',
   'Stays false: the workbook states the sampling frequency as "To set" for Ground, Conditioned, Pellets and Crumble, so an overdue flag or a percentage-compliance figure would be fabricated for four of seven stages (FR-020, risk R-08).', false);

comment on table public.system_config is
  'Runtime switches. Contains no secret and no credential; the spreadsheet ID lives only in an Edge Function secret.';


-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------

alter table public.system_config enable row level security;

create policy system_config_select_active on public.system_config
  for select to authenticated
  using (public.is_active_user());

-- No write policy. Changes go through public.set_system_config(), which checks
-- `user.manage`, refuses a key that is not operator-editable, and audits the
-- old and new values.

revoke all on public.system_config from anon, authenticated;
grant select on public.system_config to authenticated;
