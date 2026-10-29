/**
 * Tone and icon tables for every status the UI renders.
 *
 * Kept out of the component files so that each status gets exactly one
 * appearance across the whole app, and so a new state cannot be added without
 * choosing its words and its icon (these are `Record<Union, …>`, so TypeScript
 * fails the build on an unhandled member).
 *
 * PRD NFR-004 and section 11: no colour-only signals. Colour here is an
 * accent on a chip that always carries the full label text, and the icon is a
 * second non-colour channel on top of that.
 */

import {
  AlertTriangle,
  Ban,
  Boxes,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Cog,
  Eye,
  FilePen,
  Flame,
  Grip,
  HelpCircle,
  Hourglass,
  MinusCircle,
  ShieldAlert,
  Thermometer,
  Truck,
  Wheat,
  Layers,
  type LucideIcon,
} from 'lucide-react';
import type { AssessmentResult } from '@/lib/assessment';
import type { CaptureState, Disposition } from '@/lib/workflow';
import type { Stage } from '@/forms/types';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-slate-300 bg-slate-50 text-slate-800',
  info: 'border-bff-300 bg-bff-50 text-bff-800',
  success: 'border-green-300 bg-green-50 text-green-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  danger: 'border-red-300 bg-red-50 text-red-900',
};

export const CAPTURE_STATE_TONE: Record<CaptureState, Tone> = {
  draft: 'neutral',
  registered: 'info',
  awaiting_results: 'info',
  ready_for_review: 'info',
  reviewed: 'success',
  correction_required: 'warning',
  voided: 'neutral',
};

export const CAPTURE_STATE_ICON: Record<CaptureState, LucideIcon> = {
  draft: FilePen,
  registered: ClipboardCheck,
  awaiting_results: Hourglass,
  ready_for_review: Eye,
  reviewed: CheckCircle2,
  correction_required: AlertTriangle,
  voided: Ban,
};

export const DISPOSITION_TONE: Record<Disposition, Tone> = {
  undetermined: 'neutral',
  on_hold: 'danger',
  accepted: 'success',
  rejected: 'danger',
  rework_required: 'warning',
  // An authorised override is a release, but it is not a routine acceptance
  // and must not read like one on a screen somebody skims.
  released_by_authorized_override: 'warning',
};

export const DISPOSITION_ICON: Record<Disposition, LucideIcon> = {
  undetermined: HelpCircle,
  on_hold: ShieldAlert,
  accepted: CheckCircle2,
  rejected: Ban,
  rework_required: AlertTriangle,
  released_by_authorized_override: ShieldAlert,
};

export const ASSESSMENT_TONE: Record<AssessmentResult, Tone> = {
  within_limit: 'success',
  outside_limit: 'danger',
  /**
   * Amber, not grey. On seeded production data every measurement comes back
   * `not_assessable`, because none of the 34 workbook limits is approved. That
   * is correct behaviour (FR-009, UAT-05) and it is also something Quality
   * needs to keep seeing, so it is not styled as an inert absence.
   */
  not_assessable: 'warning',
  not_tested: 'neutral',
  not_applicable: 'neutral',
};

export const ASSESSMENT_ICON: Record<AssessmentResult, LucideIcon> = {
  within_limit: CheckCircle2,
  outside_limit: AlertTriangle,
  not_assessable: HelpCircle,
  not_tested: Circle,
  not_applicable: MinusCircle,
};

/**
 * One icon per process stage, for the eight dashboard cards. Chosen to be
 * distinguishable at a glance by someone who reads the number and the picture
 * before the words (Master Prompt section 2).
 */
export const STAGE_ICON: Record<Stage, LucideIcon> = {
  raw_materials: Truck,
  ground: Cog,
  conditioned: Thermometer,
  pellets: Boxes,
  extruded_soya: Flame,
  crumble: Grip,
  mash: Wheat,
  // A stack of sieves, which is literally what the DGM test is.
  dgm: Layers,
};

/**
 * The only two things the app is allowed to say about Google Sheets.
 *
 * Master Prompt section 1 and PRD FR-015: never call unsynchronised data
 * "Saved to Google Sheets", and never show success from optimistic UI state.
 * The record is in the Supabase ledger the moment the write is acknowledged;
 * the workbook row exists only once the sync worker has confirmed it.
 *
 * There is deliberately no third state. To the person reading a record, a sync
 * that is failing and being retried is still simply not in the workbook yet,
 * and a "failed" chip here would invite somebody to read a transient retry as
 * data loss. Sync failures are an operations concern and belong on the admin
 * sync screen, beside the outbox detail that explains them.
 */
export type SheetSyncState = 'pending' | 'confirmed';

export const SHEET_SYNC_LABELS: Record<SheetSyncState, string> = {
  pending: 'Recorded securely, Google Sheets sync pending',
  confirmed: 'Confirmed in Google Sheets',
};
