import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { SECONDARY_NAV } from '@/components/layout/navItems';
import { useAccess } from '@/components/layout/accessContext';

export interface SecondaryNavProps {
  /**
   * 'bar' is the compact strip under the header, shown on every screen.
   * 'panel' is the labelled block at the bottom of the dashboard.
   */
  readonly variant?: 'bar' | 'panel';
  readonly className?: string;
}

/**
 * Record navigation — searching, queues, reports, administration.
 *
 * Kept deliberately unlike the seven dashboard cards: its own `<nav>`
 * landmark with its own accessible name, a heading that says "Records and
 * administration", small text, no numbering and no process icon treatment. A
 * plant operator scanning the dashboard sees seven numbered things to do and a
 * separate list of places to look something up; nothing here can be mistaken
 * for an eighth testing form (Master Prompt section 2).
 */
export function SecondaryNav({ variant = 'bar', className }: SecondaryNavProps) {
  const { can } = useAccess();
  const items = SECONDARY_NAV.filter((item) => can(item.permission));

  if (items.length === 0) return null;

  if (variant === 'bar') {
    return (
      <nav aria-label="Records and administration" className={cn('bg-slate-50', className)}>
        <ul className="mx-auto flex max-w-6xl flex-wrap gap-1 px-2 py-1.5 sm:px-4">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'inline-flex min-h-tap items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium',
                    isActive
                      ? 'bg-white text-bff-800 shadow-sm ring-1 ring-bff-200'
                      : 'text-slate-700 hover:bg-white hover:text-bff-800',
                  )
                }
              >
                <item.icon aria-hidden="true" className="h-4 w-4" />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-labelledby="records-nav-heading" className={className}>
      <h2
        id="records-nav-heading"
        className="text-sm font-semibold uppercase tracking-wide text-slate-600"
      >
        Records and administration
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        These are places to look records up. They are not testing forms.
      </p>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              className="flex min-h-tap items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-neu-sm transition-[transform,box-shadow] duration-150 ease-out hover:border-bff-300 active:scale-[0.99] active:shadow-neu-pressed"
            >
              <item.icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
              <span>
                <span className="block font-medium text-slate-900">{item.label}</span>
                <span className="block text-sm text-slate-600">{item.description}</span>
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
