/**
 * Work in progress on a stage form, before anything is registered.
 *
 * ===========================================================================
 * WHAT A DRAFT IS, AND WHAT IT DELIBERATELY IS NOT
 * ===========================================================================
 * FR-005: "permit incomplete work-in-progress ... without pretending a sample
 * is registered. Acceptance: draft restored to same user and NOT COUNTED AS
 * COLLECTED." PRD §6.2: "Creating a draft need not allocate a sample ID unless
 * the draft has been formally registered." Master Prompt §6: "A draft can be
 * incomplete and should not silently reserve an official sample ID or populate
 * an operational log as if collected."
 *
 * So a draft here:
 *   - allocates NO sample ID. `sample_id_counters` is never touched, and
 *     nothing in this module can reach the allocator.
 *   - creates NO row in `samples`, so it appears in no worklist, no count, no
 *     KPI and no spreadsheet tab. A draft cannot be "counted as collected"
 *     because there is nothing for a count to find.
 *   - is PRIVATE to the person who wrote it, keyed by their user id.
 *
 * ===========================================================================
 * WHY THE BROWSER, AND THE LIMIT THAT FOLLOWS
 * ===========================================================================
 * The only server-side home for a draft would be a `samples` row with
 * `capture_state = 'draft'`. That table requires a non-null collection
 * instant, local date and local time, and `samples_stage_detail_only_for_ground`
 * additionally requires a sampling point for Ground — the three things an
 * operator is most likely not to have decided yet. A half-filled form
 * therefore CANNOT be stored there without inventing values, which would be
 * worse than not saving it: a fabricated collection time is a false quality
 * record, and fabricating one to satisfy a constraint is exactly the kind of
 * silent invention the build rules forbid.
 *
 * This hook therefore keeps the draft in the browser's own storage, scoped to
 * the signed-in user id, and SAYS SO in the value it returns. The honest limit
 * is that a draft is restored on the same device and the same browser profile;
 * it does not follow the operator to another tablet. The UI must not imply
 * otherwise, which is why `scopeNote` is part of the return value rather than
 * a sentence a page is free to forget.
 *
 * Storage can be entirely unavailable (private browsing, a locked-down kiosk
 * profile, a full quota). That is reported as `storage: 'unavailable'` with a
 * readable reason, never swallowed: an operator who presses Save draft must
 * find out that nothing was saved.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { STAGES, type Stage } from '@/forms/types';
import type { StageFormValues } from '@/forms/zodSchema';

/**
 * One stored draft. `userId` is recorded inside the payload as well as in the
 * key, because plant tablets are shared: if a key ever survives an account
 * switch, the mismatch is detected and the draft ignored rather than shown to
 * the wrong person and later submitted under their name.
 */
export interface SampleDraft {
  readonly stage: Stage;
  readonly userId: string;
  readonly values: StageFormValues;
  /** ISO UTC instant. Displayed in plant-local time by the caller. */
  readonly savedAt: string;
}

export type DraftStorageState = 'ready' | 'unavailable';

export interface UseSampleDraftResult {
  /** The stored draft for this user and stage, or null if there is none. */
  readonly draft: SampleDraft | null;
  readonly storage: DraftStorageState;
  /** Why storage is unavailable, or why a read or write failed. */
  readonly error: string | null;
  /** True once a read has been attempted, so a page can avoid a flash. */
  readonly loaded: boolean;
  /** Returns false when nothing was stored, so a caller cannot report success. */
  readonly save: (values: StageFormValues) => boolean;
  readonly clear: () => void;
  /** The plain-words limit of where this draft lives. Show it; do not reword it. */
  readonly scopeNote: string;
}

export const DRAFT_SCOPE_NOTE =
  'A draft is kept on this device for you only. It has no sample ID, it is not ' +
  'counted as a collected sample, and it is not in the system or the ' +
  'spreadsheet until you register it.';

const KEY_NAMESPACE = 'bff-sample-testing-draft';

/** `bff-sample-testing-draft:<user id>:<stage>`. One draft per stage per user. */
export function draftStorageKey(userId: string, stage: Stage): string {
  return `${KEY_NAMESPACE}:${userId}:${stage}`;
}

function storage(): Storage | null {
  try {
    // Reading the property itself throws in some locked-down configurations,
    // so the access is inside the try rather than guarded by a typeof check.
    const candidate = window.localStorage;
    const probe = `${KEY_NAMESPACE}:probe`;
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Parse a stored draft, rejecting anything that is not exactly the expected
 * shape for this user and stage. A draft is operator input that has been
 * round-tripped through storage another program could have written to, so it
 * is validated on the way in rather than trusted.
 */
function parseDraft(raw: string, userId: string, stage: Stage): SampleDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (!isStage(record['stage']) || record['stage'] !== stage) return null;
  if (record['userId'] !== userId) return null;
  if (typeof record['savedAt'] !== 'string') return null;

  const storedValues = record['values'];
  if (typeof storedValues !== 'object' || storedValues === null || Array.isArray(storedValues)) {
    return null;
  }

  // Only string entries survive. The form layer treats every control's value
  // as the operator's raw text, and a number here would reintroduce the
  // precision loss that representation exists to prevent.
  const values: StageFormValues = {};
  for (const [key, value] of Object.entries(storedValues)) {
    if (typeof value === 'string') values[key] = value;
  }

  return { stage, userId, values, savedAt: record['savedAt'] };
}

/**
 * Per-user draft for one stage form.
 *
 * `userId` comes from the signed-in profile. Pass `null` while it is still
 * unknown: no draft is read or written for an unidentified user, because a
 * draft written without an owner could be restored for whoever opens the form
 * next on a shared tablet.
 */
export function useSampleDraft(userId: string | null, stage: Stage): UseSampleDraftResult {
  const [draft, setDraft] = useState<SampleDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const key = userId === null ? null : draftStorageKey(userId, stage);

  useEffect(() => {
    if (userId === null || key === null) {
      setDraft(null);
      setLoaded(false);
      return;
    }

    const store = storage();
    if (store === null) {
      setAvailable(false);
      setDraft(null);
      setLoaded(true);
      setError(
        'This browser will not let the app keep a draft on the device. You can still ' +
          'register the sample now, but an unfinished form cannot be saved.',
      );
      return;
    }

    setAvailable(true);
    try {
      const raw = store.getItem(key);
      const parsedDraft = raw === null ? null : parseDraft(raw, userId, stage);
      if (raw !== null && parsedDraft === null) {
        // Unreadable or foreign: remove it rather than leave a value that will
        // be re-read and re-rejected on every visit.
        store.removeItem(key);
      }
      setDraft(parsedDraft);
      setError(null);
    } catch (cause) {
      setDraft(null);
      setError(
        cause instanceof Error
          ? `The saved draft could not be read: ${cause.message}`
          : 'The saved draft could not be read.',
      );
    }
    setLoaded(true);
  }, [key, stage, userId]);

  const save = useCallback(
    (values: StageFormValues): boolean => {
      if (userId === null || key === null) {
        setError('Your sign-in is still being checked, so the draft was not saved.');
        return false;
      }
      const store = storage();
      if (store === null) {
        setAvailable(false);
        setError(
          'This browser will not let the app keep a draft on the device, so nothing was saved.',
        );
        return false;
      }

      const next: SampleDraft = {
        stage,
        userId,
        // A copy: the form keeps editing its own object after this returns.
        values: { ...values },
        savedAt: new Date().toISOString(),
      };

      try {
        store.setItem(key, JSON.stringify(next));
      } catch (cause) {
        setAvailable(true);
        setError(
          cause instanceof Error
            ? `The draft could not be saved on this device: ${cause.message}`
            : 'The draft could not be saved on this device.',
        );
        return false;
      }

      setAvailable(true);
      setDraft(next);
      setError(null);
      return true;
    },
    [key, stage, userId],
  );

  const clear = useCallback(() => {
    setDraft(null);
    if (key === null) return;
    const store = storage();
    if (store === null) return;
    try {
      store.removeItem(key);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `The draft could not be removed from this device: ${cause.message}`
          : 'The draft could not be removed from this device.',
      );
    }
  }, [key]);

  return useMemo(
    () => ({
      draft,
      storage: available ? 'ready' : 'unavailable',
      error,
      loaded,
      save,
      clear,
      scopeNote: DRAFT_SCOPE_NOTE,
    }),
    [available, clear, draft, error, loaded, save],
  );
}
