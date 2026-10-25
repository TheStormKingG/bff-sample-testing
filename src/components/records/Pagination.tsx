/**
 * Server-side pagination controls.
 *
 * The range text states what is actually known. When the server did not return
 * a total, the control says the total is unknown rather than printing a
 * plausible-looking page count derived from nothing.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './common';

export function Pagination({
  page,
  pageSize,
  total,
  totalUnknown,
  rowsOnPage,
  onPageChange,
  busy,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  total: number;
  totalUnknown: boolean;
  rowsOnPage: number;
  onPageChange: (page: number) => void;
  busy?: boolean;
}) {
  const first = total === 0 && !totalUnknown ? 0 : page * pageSize + 1;
  const last = page * pageSize + rowsOnPage;
  const hasNext = totalUnknown ? rowsOnPage === pageSize : last < total;
  const hasPrevious = page > 0;

  return (
    <nav
      aria-label="Result pages"
      className="flex flex-col gap-3 border-t border-slate-200 pt-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-slate-700" role="status">
        {rowsOnPage === 0
          ? 'No records on this page'
          : totalUnknown
            ? `Showing records ${first} to ${last}. The total number of matching records was not reported by the server.`
            : `Showing records ${first} to ${last} of ${total}`}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => onPageChange(page - 1)} disabled={!hasPrevious || busy === true}>
          <ChevronLeft aria-hidden className="h-4 w-4" />
          Previous
        </Button>
        <Button onClick={() => onPageChange(page + 1)} disabled={!hasNext || busy === true}>
          Next
          <ChevronRight aria-hidden className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
