/**
 * The quality-hold banner.
 *
 * A hold overrides every permissive signal (Master Prompt §5), so it is drawn
 * to outrank them: full width, at the very top of the record, in the strongest
 * treatment on the screen, with its own heading and `role="alert"`. A row of
 * green "Within limit" chips further down must never be the first thing a
 * reader sees on a held sample.
 *
 * Only a user with hold-clearing authority is offered the clear action. A
 * Quality Officer can raise a hold but not clear one.
 */

import { PauseCircle, ShieldAlert } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import type { HoldTrigger } from '@/lib/assessment';
import type { HoldRow } from '@/hooks/useSampleDetail';
import { Button } from './common';

export function HoldBanner({
  hold,
  triggers,
  canClear,
  onClear,
}: {
  hold: HoldRow | null;
  /** Conditions that currently justify a hold, whether or not one is raised. */
  triggers: readonly HoldTrigger[];
  canClear: boolean;
  onClear: () => void;
}) {
  // A trigger with no hold raised yet is still a warning the reader needs.
  if (hold === null) {
    if (triggers.length === 0) return null;
    return (
      <div
        role="alert"
        className="mb-6 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 shadow-sm"
      >
        <h2 className="flex items-center gap-2 text-xl font-bold text-amber-900">
          <ShieldAlert aria-hidden className="h-6 w-6" />
          This sample meets the conditions for a quality hold
        </h2>
        <ul className="mt-2 list-inside list-disc text-base text-amber-900">
          {triggers.map((t) => (
            <li key={`${t.kind}-${t.fieldKey}`}>{t.detail}</li>
          ))}
        </ul>
        <p className="mt-2 text-base text-amber-900">
          No hold has been recorded yet. The material must not be released until a Quality Officer
          or Supervisor decides.
        </p>
      </div>
    );
  }

  return (
    <div role="alert" className="mb-6 rounded-lg border-4 border-red-700 bg-red-50 p-4 shadow-md">
      <h2 className="flex items-center gap-2 text-2xl font-bold text-red-900">
        <PauseCircle aria-hidden className="h-7 w-7 flex-shrink-0" />
        On quality hold — do not release this material
      </h2>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-base text-red-900 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="font-semibold">Raised by</dt>
          <dd>{hold.raised_by_name ?? 'Not recorded'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold">Raised at</dt>
          <dd>{formatPlantDateTimeLabelled(new Date(hold.raised_at))}</dd>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <dt className="font-semibold">Reason</dt>
          <dd>{hold.reason ?? 'No reason recorded'}</dd>
        </div>
      </dl>

      {triggers.length > 0 ? (
        <>
          <p className="mt-3 font-semibold text-red-900">What triggered it</p>
          <ul className="mt-1 list-inside list-disc text-base text-red-900">
            {triggers.map((t) => (
              <li key={`${t.kind}-${t.fieldKey}`}>{t.detail}</li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="mt-3 text-base font-medium text-red-900">
        A hold outranks every test result on this page. Results shown below as within limit do not
        release the material while this hold stands.
      </p>

      <div className="mt-4">
        {canClear ? (
          <Button variant="danger" onClick={onClear}>
            Clear this hold
          </Button>
        ) : (
          <p className="text-base text-red-900">
            You are not authorised to clear a hold. A Quality Supervisor, or someone holding a
            recorded delegation, must do it.
          </p>
        )}
      </div>
    </div>
  );
}
