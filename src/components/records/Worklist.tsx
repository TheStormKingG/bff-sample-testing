/**
 * A worklist: the same sample data, filtered to the work it needs.
 *
 * The three worklists are views, not separate stores. Each one states what
 * makes a record appear in it, so a reader never has to guess the rule behind
 * the list, and each distinguishes loading, failed and genuinely empty.
 */

import type { ReactNode } from 'react';
import { PAGE_SIZE, useWorklist } from '@/hooks/useSamples';
import { Card, EmptyState, ErrorNotice, LoadingBlock, PageHeader } from './common';
import { SampleTable } from './SampleTable';
import { Pagination } from './Pagination';

export function Worklist({
  kind,
  title,
  description,
  inclusionRule,
  emptyTitle,
  emptyHint,
  page,
  onPageChange,
  banner,
}: {
  kind: 'awaiting' | 'review' | 'holds';
  title: string;
  description: string;
  /** Plain-language statement of what puts a record in this list. */
  inclusionRule: string;
  emptyTitle: string;
  emptyHint: string;
  page: number;
  onPageChange: (page: number) => void;
  banner?: ReactNode;
}) {
  const list = useWorklist(kind, page);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader title={title} description={description} />
      {banner}
      <Card description={inclusionRule}>
        {list.isPending ? (
          <LoadingBlock label={`Loading ${title.toLowerCase()}`} />
        ) : list.isError ? (
          <ErrorNotice error={list.error} what={title} onRetry={() => void list.refetch()} />
        ) : list.data.rows.length === 0 ? (
          <EmptyState title={emptyTitle} hint={emptyHint} />
        ) : (
          <div className="flex flex-col gap-4">
            {list.isFetching ? (
              <p role="status" className="text-sm text-slate-600">
                Updating…
              </p>
            ) : null}
            <SampleTable rows={list.data.rows} />
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data.total}
              totalUnknown={list.data.totalUnknown}
              rowsOnPage={list.data.rows.length}
              onPageChange={onPageChange}
              busy={list.isFetching}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
