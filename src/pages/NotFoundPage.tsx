import { Link } from 'react-router-dom';
import { MapPinOff } from 'lucide-react';

/**
 * An address that does not exist in this app.
 *
 * Reachable on a stale bookmark or a mistyped hash. It is deliberately free of
 * any data fetch, because it also renders for addresses a signed-out visitor
 * typed in.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <MapPinOff aria-hidden="true" className="mx-auto h-10 w-10 text-slate-400" />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
        This page does not exist
      </h1>
      <p className="mt-2 text-base text-slate-600">
        The address may have been mistyped, or the link may be from an older version of the
        app.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex min-h-tap items-center justify-center rounded-lg border border-bff-800 bg-bff-700 px-5 py-2.5 font-semibold text-white hover:bg-bff-800"
      >
        Go to the dashboard
      </Link>
    </div>
  );
}

export default NotFoundPage;
