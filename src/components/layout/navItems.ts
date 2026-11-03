import {
  ClipboardList,
  BarChart3,
  Flag,
  LayoutGrid,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/lib/roles';

/**
 * The five destinations in the bottom bar, and the whole of the app's
 * navigation.
 *
 * ===========================================================================
 * WHAT THIS REPLACED, AND WHY
 * ===========================================================================
 * Until 2026-11-03 there were seven: Home, Samples, Awaiting Results, Holds,
 * Reviews, Approved limits and Reports, rendered as a strip across the top on
 * a wide screen and as a sheet behind a "More" button on a phone. Three of
 * them — Awaiting Results, Holds, Reviews — were three lists of the same
 * table asking three questions about the same work, and a person wanting to
 * know "what needs me?" had to visit all three and hold the answer in their
 * head.
 *
 * They are now one screen, `Flagged`, which asks that question once. Reports
 * joined the Dashboard as a tab beside the quality overview, because a figure
 * and the report behind it are the same subject. Approved limits moved into
 * Admin. What is left is five, which is what fits across the bottom of a
 * phone at a finger's width without crowding.
 *
 * ===========================================================================
 * EVERY ITEM IS A DESTINATION, NOT A FORM
 * ===========================================================================
 * Master Prompt section 2 is explicit that navigation must never read as an
 * additional testing form. The seven numbered stage cards on Home are the
 * only way into a form, and nothing here is numbered or named after a stage.
 *
 * `permission` gates what is OFFERED. It is not the control — see
 * `RequirePermission`, which gates what can be REACHED.
 */
export interface NavItem {
  readonly to: string;
  readonly label: string;
  /** One line of plain language, for an operator skimming the list. */
  readonly description: string;
  readonly icon: LucideIcon;
  /**
   * Null for a destination every signed-in person may open.
   *
   * Home has none deliberately: it is the way OUT of every other screen, and
   * gating it would strand whoever failed the check on a page with no exit.
   */
  readonly permission: Permission | null;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  {
    to: '/',
    label: 'Home',
    description: 'The testing forms',
    icon: LayoutGrid,
    permission: null,
  },
  {
    to: '/samples',
    label: 'Samples',
    description: 'Find any sample by ID, lot, batch or run',
    icon: ClipboardList,
    permission: 'sample.view',
  },
  {
    to: '/flagged',
    label: 'Flagged',
    description: 'Holds, out-of-limit results and work waiting on somebody',
    icon: Flag,
    permission: 'sample.view',
  },
  {
    to: '/dashboard',
    label: 'Dashboard',
    description: 'Quality overview and reports',
    icon: BarChart3,
    permission: 'report.view',
  },
  {
    to: '/admin',
    label: 'Admin',
    description: 'Approved limits, users, controlled lists and sync health',
    icon: UserCog,
    permission: 'user.manage',
  },
];

/**
 * The way back to the testing forms.
 *
 * Still exported under its old name because `Header` and the not-found page
 * use it as "the way home" rather than as a nav entry, and that is a
 * different job from being first in the bar.
 */
export const HOME_NAV_ITEM = PRIMARY_NAV[0]!;
