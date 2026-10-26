/**
 * The sample's history, straight from `audit_events`.
 *
 * Append-only by design, so this view never offers an edit. Before/after
 * values are shown where the event recorded them, because a correction without
 * its prior value is not a trace (FR-013, NFR-005).
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import type { AuditEventRow } from '@/hooks/useSamples';
import { EmptyState } from './common';

/** Turn an event's stored action code into plain language for the plant. */
const ACTION_LABELS: Record<string, string> = {
  draft_created: 'Draft started',
  sample_registered: 'Sample registered',
  results_entered: 'Test results entered',
  results_amended: 'Test results amended',
  correction_requested: 'Correction requested',
  review_recorded: 'Review recorded',
  hold_raised: 'Quality hold raised',
  hold_cleared: 'Quality hold cleared',
  disposition_recorded: 'Material decision recorded',
  override_release_recorded: 'Release recorded as an authorised override',
  sample_voided: 'Sample voided',
  sheet_sync_confirmed: 'Confirmed in Google Sheets',
  sheet_sync_failed: 'Google Sheets sync failed',
  specification_approved: 'Specification approved',
};

function describeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

/**
 * Who the event says acted.
 *
 * `audit_events` records `actor_id` and `actor_email` and has no name column at
 * all; `record_audit_event` resolves the address from `profiles.email` at write
 * time, so what is stored is the address the action was taken under, frozen at
 * that instant. The `actor_name` field on `AuditEventRow` carries that address.
 *
 * It is deliberately NOT resolved to `profiles.display_name` here. Two reasons,
 * and the first is the one that matters: `display_name` is mutable, so a later
 * rename would change what a historical event appears to say, and an
 * append-only trail exists precisely so that the record does not follow the
 * present. The person as they were known at the time IS the recorded address.
 * The second is mechanical — this component renders rows from two different
 * hooks and holds no query of its own, so resolving a name here would mean a
 * lookup per screen and a displayed actor that depends on the profiles table
 * rather than on the event.
 *
 * Where the address is absent the account id is shown instead: the actor IS
 * recorded, as a uuid, so "not recorded" would be false.
 *
 * AND WHERE BOTH ARE ABSENT, THAT IS A SYSTEM ACTION, NOT A MISSING ONE. The
 * schema says so explicitly — `0012_rpc_platform.sql:195` documents
 * `audit_events.actor_id` as nullable "for a system..." — and the commissioning
 * grant in `0018` writes exactly such a row, deliberately, because no person
 * performed it. Rendering that as "Actor not recorded" would make the trail
 * deny having recorded something it recorded on purpose, which is worse than
 * the uuid it was introduced to avoid: a reader cannot tell a system action
 * from a logging failure, and one of those is a defect to chase.
 */
function describeActor(event: AuditEventRow): string {
  if (event.actor_name !== null && event.actor_name !== '') return event.actor_name;
  if (event.actor_id !== null) return `account ${event.actor_id} — no email recorded`;
  return 'System — no person performed this';
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return String(value).length > 0;
}

function ValueBlock({ label, value }: { label: string; value: unknown }) {
  if (!hasContent(value)) return null;
  return (
    <div className="mt-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-800">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Event({ event }: { event: AuditEventRow }) {
  const [open, setOpen] = useState(false);
  const detailed = hasContent(event.prior_values) || hasContent(event.new_values);
  const occurred = new Date(event.occurred_at);
  const when = Number.isNaN(occurred.getTime())
    ? event.occurred_at
    : formatPlantDateTimeLabelled(occurred);

  return (
    <li className="border-b border-slate-100 py-3 last:border-b-0">
      <p className="text-base font-medium text-slate-900">{describeAction(event.action)}</p>
      <p className="text-sm text-slate-700">
        {when} · {describeActor(event)}
      </p>
      {event.reason ? (
        <p className="mt-1 text-base text-slate-800">
          <span className="font-medium">Reason: </span>
          {event.reason}
        </p>
      ) : null}
      {detailed ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="mt-1 inline-flex min-h-tap items-center gap-1 text-sm text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
          >
            {open ? (
              <ChevronDown aria-hidden className="h-4 w-4" />
            ) : (
              <ChevronRight aria-hidden className="h-4 w-4" />
            )}
            {open ? 'Hide what changed' : 'Show what changed'}
          </button>
          {open ? (
            <div>
              <ValueBlock label="Before" value={event.prior_values} />
              <ValueBlock label="After" value={event.new_values} />
            </div>
          ) : null}
        </>
      ) : null}
      {event.app_version ? (
        <p className="mt-0.5 text-xs text-slate-500">
          Recorded under deployment version {event.app_version}
        </p>
      ) : null}
    </li>
  );
}

export function AuditTimeline({ events }: { events: readonly AuditEventRow[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No history has been recorded for this sample yet."
        hint="Every registration, result entry, review and decision is written here and cannot be edited or deleted."
      />
    );
  }

  return (
    <div>
      <p className="mb-2 flex items-center gap-2 text-sm text-slate-600">
        <History aria-hidden className="h-4 w-4" />
        Most recent first. This history is append-only and cannot be edited. People are
        identified by the email address recorded with each event — the log stores no display
        name.
      </p>
      <ol className="list-none">
        {events.map((event) => (
          <Event key={event.id} event={event} />
        ))}
      </ol>
    </div>
  );
}
