import {
  ClipboardList,
  Eye,
  Hourglass,
  ListChecks,
  BarChart3,
  ShieldAlert,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/lib/roles';

/**
 * The secondary, record-oriented destinations.
 *
 * These are NOT testing forms. The dashboard's seven numbered cards are the
 * only way into a form, and Master Prompt section 2 is explicit that these
 * entries "are not additional testing-form buttons" — hence the separate
 * table, the separate landmark and the different visual weight.
 *
 * `permission` gates what is OFFERED. It is not the control: see
 * `RequirePermission`.
 */
export interface NavItem {
  readonly to: string;
  readonly label: string;
  /** One line of plain language, for an operator skimming the list. */
  readonly description: string;
  readonly icon: LucideIcon;
  readonly permission: Permission;
}

export const SECONDARY_NAV: readonly NavItem[] = [
  {
    to: '/samples',
    label: 'Samples',
    description: 'Find any sample by ID, lot, batch or run',
    icon: ClipboardList,
    permission: 'sample.view',
  },
  {
    to: '/awaiting',
    label: 'Awaiting Results',
    description: 'Registered samples with tests still to be entered',
    icon: Hourglass,
    permission: 'sample.view',
  },
  {
    to: '/holds',
    label: 'Holds',
    description: 'Material held pending a quality decision',
    icon: ShieldAlert,
    permission: 'sample.view',
  },
  {
    to: '/reviews',
    label: 'Reviews',
    description: 'Samples ready for a quality review',
    icon: Eye,
    permission: 'sample.review',
  },
  {
    to: '/specifications',
    label: 'Approved limits',
    description: 'The limits in force, and which are still to be set',
    icon: ListChecks,
    permission: 'report.view',
  },
  {
    to: '/reports',
    label: 'Reports',
    description: 'Volumes, exceptions and queues',
    icon: BarChart3,
    permission: 'report.view',
  },
  {
    to: '/admin',
    label: 'Admin',
    description: 'Users, access approvals and sync health',
    icon: UserCog,
    permission: 'user.manage',
  },
];
