/**
 * Samples whose results are in and are waiting for a review.
 *
 * Reviewing and deciding about the material are two separate acts. A review
 * records that the results were checked; releasing, rejecting or reworking the
 * material is a disposition, taken by someone with that authority and always
 * with a recorded reason (PRD §6.2).
 */

import { useState } from 'react';

import { useAuthority } from '@/hooks/useSamples';
import { InfoNote, NotPermitted } from '@/components/records/common';
import { Worklist } from '@/components/records/Worklist';

export default function ReviewsPage() {
  const [page, setPage] = useState(0);
  const { allows } = useAuthority();

  return (
    <Worklist
      kind="review"
      title="Ready for review"
      description="Samples with all required results recorded, waiting for a quality review."
      inclusionRule="A sample appears here while its record state is Ready for review. It leaves the list once a review is recorded, or if a correction is requested."
      emptyTitle="Nothing is waiting for review."
      emptyHint="A sample arrives here as soon as all of its required results are saved."
      page={page}
      onPageChange={setPage}
      banner={
        <div className="mb-5">
          {allows('sample.review') ? (
            <InfoNote>
              A review records that the results were checked. It does not release the material: use
              &ldquo;Record a material decision&rdquo; on the sample for that, which needs its own
              authority and a reason.
            </InfoNote>
          ) : (
            <NotPermitted reason="You can see this list but not record a review. Reviewing is done by a Quality Officer or Quality Supervisor." />
          )}
        </div>
      }
    />
  );
}
