import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, letting a later Tailwind utility win over an earlier one
 * in the same group. Without the merge step a component's own `min-h-tap`
 * could be silently defeated by a caller's `min-h-0`, which would quietly
 * break the 44px tap-target requirement (PRD NFR-004).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
