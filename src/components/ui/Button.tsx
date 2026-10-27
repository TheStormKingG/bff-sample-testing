import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from '@/components/ui/Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner and blocks further clicks. Keeps the label visible. */
  readonly loading?: boolean;
  /** Replaces the label while `loading`, for a long or risky action. */
  readonly loadingLabel?: string;
  readonly leadingIcon?: ReactNode;
  readonly fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-bff-700 text-white hover:bg-bff-800 active:bg-bff-900 border border-bff-800',
  secondary:
    'bg-white text-bff-800 border border-bff-300 hover:bg-bff-50 active:bg-bff-100',
  ghost: 'bg-transparent text-slate-700 border border-transparent hover:bg-slate-100',
  // Red carries no meaning on its own here; destructive buttons always say
  // what they do in words, and high-impact ones go through ConfirmDialog.
  danger: 'bg-red-700 text-white hover:bg-red-800 active:bg-red-900 border border-red-800',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-tap min-w-tap px-4 py-2.5 text-base',
  lg: 'min-h-[56px] min-w-tap px-6 py-3 text-lg',
};

/**
 * The one button in the app.
 *
 * `min-h-tap` (44px) is on every size because these are pressed with a thumb,
 * often with a glove on (PRD NFR-004). `type` defaults to `button` rather than
 * the HTML default of `submit`, so a button dropped into a form cannot submit
 * a sample by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel,
    leadingIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        // `whitespace-nowrap` is a product rule, not a style preference: no
        // button label in this app may break across two lines. A wrapped
        // label makes the control taller than the row it belongs to, and on
        // the phone form that extra height came straight out of the sticky
        // action bar's share of an 812px screen. Enforced here so every
        // consumer inherits it rather than each remembering.
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" label="Working" className="text-current" />
      ) : (
        leadingIcon
      )}
      <span>{loading && loadingLabel !== undefined ? loadingLabel : children}</span>
    </button>
  );
});
