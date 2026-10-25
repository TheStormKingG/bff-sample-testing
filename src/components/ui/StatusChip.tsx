import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { TONE_CLASSES, type Tone } from '@/components/ui/statusMaps';

export interface StatusChipProps {
  /** The full status wording. Never abbreviated to a colour or a symbol. */
  readonly label: ReactNode;
  readonly tone?: Tone;
  readonly icon?: LucideIcon;
  /** Spoken before the label, e.g. "Capture state:". */
  readonly srPrefix?: string;
  readonly className?: string;
  readonly size?: 'sm' | 'md';
}

/**
 * A status pill: border, tint, icon and words. The words are mandatory, which
 * is the whole point — PRD section 11 forbids communicating risk with colour
 * alone, and this component makes the compliant version the easy one.
 */
export function StatusChip({
  label,
  tone = 'neutral',
  icon: Icon,
  srPrefix,
  className,
  size = 'md',
}: StatusChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon !== undefined && (
        <Icon aria-hidden="true" className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      )}
      {srPrefix !== undefined && <span className="sr-only">{srPrefix} </span>}
      <span>{label}</span>
    </span>
  );
}
