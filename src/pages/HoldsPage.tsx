/**
 * Material on quality hold.
 *
 * A hold outranks every permissive signal, including a measurement that sits
 * inside an approved limit, so this list is about material that must not be
 * used — not about records that need tidying.
 */

import { useState } from 'react';
import { PauseCircle } from 'lucide-react';

import { useAuthority } from '@/hooks/useSamples';
import { Worklist } from '@/components/records/Worklist';

export default function HoldsPage() {
  const [page, setPage] = useState(0);
  const { allows } = useAuthority();

  return (
    <Worklist
      kind="holds"
      title="On quality hold"
      description="Material that must not be used until an authorised approver decides."
      inclusionRule="A sample appears here while a hold is active on it. A hold is raised automatically by an adverse visual finding or a result outside an approved limit, and can also be raised by hand."
      emptyTitle="No material is on quality hold."
      emptyHint="A hold appears here the moment one is raised, whether automatically or by a person."
      page={page}
      onPageChange={setPage}
      banner={
        <div
          className="mb-5 rounded-md border-2 border-red-600 bg-red-50 p-4"
          role="region"
          aria-label="What a hold means"
        >
          <p className="flex items-center gap-2 text-lg font-bold text-red-900">
            <PauseCircle aria-hidden className="h-6 w-6" />
            Held material must not be used or shipped
          </p>
          <p className="mt-1 text-base text-red-900">
            {allows('hold.clear')
              ? 'You are authorised to clear a hold. Clearing a hold records that the reason is resolved; it is not by itself an acceptance of the material.'
              : 'You can raise a hold but not clear one. A Quality Supervisor, or someone with a recorded delegation, must clear it.'}
          </p>
        </div>
      }
    />
  );
}
