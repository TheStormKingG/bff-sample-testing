/**
 * Home: the testing forms.
 *
 * A thin route wrapper. It used to be the dashboard, which chose between an
 * eight-tile phone grid and a desktop layout carrying forms, queue figures
 * and a records panel all at once. Those three jobs now have three screens —
 * Home, Flagged and Dashboard — so this one only has to decide whether the
 * signed-in role records samples at all.
 */

import { HomeScreen } from '@/components/home/HomeScreen';
import { useAccess } from '@/components/layout/accessContext';

export default function HomePage() {
  const { can } = useAccess();
  return <HomeScreen mayRecord={can('sample.draft')} />;
}
