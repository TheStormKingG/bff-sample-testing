import { useEffect, useState } from 'react';

/**
 * The screen between pressing Register and the record appearing.
 *
 * ===========================================================================
 * WHY A FULL-SCREEN PANEL FOR ONE REQUEST
 * ===========================================================================
 * Registering is the moment a sample stops being something an operator typed
 * and becomes a record with an identifier. On a phone, on mill wifi, the
 * round trip is sometimes a second and sometimes eight — and the form, which
 * looks exactly as it did before the press, gives a person standing beside a
 * bagging line no reason to believe anything happened. The one behaviour that
 * must never occur is a second press, because that is how a duplicate record
 * is made: the idempotency key makes the SERVER safe, but the operator still
 * ends up watching a screen they have lost confidence in.
 *
 * So the form is covered. Nothing is clickable underneath, the panel says in
 * plain words what is happening, and it is gone the instant the server
 * answers — the confirmation replaces the form in the same render.
 *
 * ===========================================================================
 * THE BAR MOVES. IT DOES NOT MEASURE. THAT DISTINCTION IS LOAD-BEARING.
 * ===========================================================================
 * There is exactly one request and the browser cannot see inside it, so there
 * is no honest percentage to show. A bar reading "73%" would be an invented
 * number on the screen of a quality system, which is the one place a made-up
 * figure should never appear.
 *
 * What is shown instead is a bar that eases toward — and never reaches — the
 * end of its track, with NO NUMBER ANYWHERE. That is an accurate statement:
 * work is in progress and it is not finished. The fill only completes when
 * the server has actually answered, and by then this panel is already being
 * unmounted. A reader who wants the rule: nothing on this component may ever
 * be given a percentage, an ETA or a step count that the client cannot
 * observe.
 *
 * ===========================================================================
 * AND IT STOPS MOVING FOR ANYONE WHO ASKED IT TO
 * ===========================================================================
 * `prefers-reduced-motion` removes the animation entirely rather than slowing
 * it: the panel then states what is happening in words, which was always the
 * part carrying the information. The bar was the reassurance.
 */
export interface RegisterProgressProps {
  /** What is being recorded, in the operator's words. */
  readonly label?: string;
  /**
   * Seeded elapsed fraction, for tests. Production starts at zero; a test
   * that needs a drawn bar does not have to wait for a timer to tick.
   */
  readonly initialProgress?: number;
}

/** How close to the end the bar may creep while it still knows nothing. */
const CEILING = 0.92;
/** Milliseconds between steps. Slow enough to be cheap, fast enough to read. */
const TICK_MS = 90;

export function RegisterProgress({
  label = 'Recording the sample',
  initialProgress = 0,
}: RegisterProgressProps): JSX.Element {
  const [progress, setProgress] = useState(initialProgress);
  const [animate, setAnimate] = useState(true);

  useEffect(() => {
    // `matchMedia` is absent in some test environments; no match means the
    // user has expressed no preference, which is the animated default.
    const query =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    if (query === null) return;
    const apply = (): void => setAnimate(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!animate) return;
    const timer = window.setInterval(() => {
      // Each step closes a fixed FRACTION of what is left, so the bar moves
      // quickly at first and visibly slows — which is the shape of "still
      // working" and never arrives anywhere it has not earned.
      setProgress((current) => current + (CEILING - current) * 0.08);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [animate]);

  return (
    <div
      // `status`, not `alert`: this is progress, not a problem. `aria-busy`
      // is what tells a screen reader the region is mid-operation.
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm print:hidden"
    >
      <div className="w-full max-w-sm rounded-neu bg-neu-base p-6 shadow-xl">
        <p className="text-lg font-bold text-slate-900">{label}</p>
        <p className="mt-1 text-sm text-slate-600">
          Do not press Register again. This screen closes by itself when the record is saved.
        </p>

        {animate ? (
          <div
            // NOT `role="progressbar"`: that role invites `aria-valuenow`,
            // and there is no honest value to put in it. The bar is
            // decoration over a `status` region whose words carry the state.
            aria-hidden="true"
            className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
          >
            <div
              className="h-full rounded-full bg-blue-700 transition-[width] duration-150 ease-out"
              style={{ width: `${Math.min(progress, CEILING) * 100}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
