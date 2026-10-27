import { useSyncExternalStore } from 'react';

/**
 * Tailwind's `sm` breakpoint, as a media query string.
 *
 * Written here so the JavaScript and the stylesheet cannot drift: "phone" in
 * this app means "narrower than `sm`", and `sm:` in a class name means
 * `(min-width: 640px)`. If the breakpoint moves in tailwind.config.js it must
 * move here too.
 */
const SM_QUERY = '(min-width: 640px)';

function matcher(): MediaQueryList | null {
  // `matchMedia` is absent in some test environments. Treating that as "wide"
  // is the safe default: the wide dashboard works at every size, whereas the
  // phone home screen assumes it owns the whole viewport.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(SM_QUERY);
}

function subscribe(listener: () => void): () => void {
  const mql = matcher();
  if (mql === null) return () => {};
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}

/** True when the viewport is `sm` or wider. */
function getSnapshot(): boolean {
  const mql = matcher();
  // `true` — "assume wide" — when the API is missing. Note the polarity: this
  // function answers "is it at least sm?", so the safe default here is the
  // one that makes `useIsPhone` FALSE. An earlier version returned `false`,
  // which read as a cautious default and in fact forced every environment
  // without `matchMedia` onto the phone screen. tests/dashboardBreakpoint
  // pins this down.
  return mql === null ? true : mql.matches;
}

/**
 * True below Tailwind's `sm` breakpoint — i.e. on a phone.
 *
 * WHY A HOOK AND NOT `sm:hidden` ON TWO TREES. Rendering both layouts and
 * hiding one with CSS puts two links to `#/stage/raw_materials` in the
 * document at once. Everything that addresses the dashboard by its routing
 * contract — the acceptance specs do exactly that, deliberately, because an
 * href cannot drift with a class name — then matches two elements and fails.
 * This was measured, not guessed: the first version of this screen broke
 * `e2e/dashboard.spec.ts` that way.
 *
 * `getSnapshot` is read during render, so the correct layout is in the first
 * paint; there is no flash of the wrong one.
 */
export function useIsPhone(): boolean {
  return !useSyncExternalStore(subscribe, getSnapshot, () => true);
}
