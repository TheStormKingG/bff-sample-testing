/**
 * Samples that have been registered but still need test results.
 *
 * A Quality Officer adds results to the SAME registered sample. Starting a
 * second log row for the same material is the error this list exists to
 * prevent (FR-007).
 */

import { useState } from 'react';
import { InfoNote } from '@/components/records/common';
import { Worklist } from '@/components/records/Worklist';

export default function AwaitingResultsPage() {
  const [page, setPage] = useState(0);

  return (
    <Worklist
      kind="awaiting"
      title="Waiting for test results"
      description="Samples already registered in the plant whose tests are not yet recorded."
      inclusionRule="A sample appears here while its record state is Registered, Awaiting results or Correction required. It leaves the list when the results are saved and it moves to Ready for review."
      emptyTitle="Nothing is waiting for test results."
      emptyHint="Every registered sample has its results recorded. New samples appear here as soon as they are registered."
      page={page}
      onPageChange={setPage}
      banner={
        <div className="mb-5">
          <InfoNote>
            Open the sample and add the results to that record. Do not register the sample again —
            a second record would split one physical sample into two quality histories.
          </InfoNote>
        </div>
      }
    />
  );
}
