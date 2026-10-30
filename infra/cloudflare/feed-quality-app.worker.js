/**
 * Serves the BFF Sample Testing app at https://bountyfarmltd.com/FeedQualityApp/
 *
 * WHY A WORKER AND NOT A CUSTOM DOMAIN ON GITHUB PAGES.
 * A custom domain attached to a Pages PROJECT site is served from the root of
 * that domain. Pointing bountyfarmltd.com at Pages would therefore hand the
 * whole apex to this application and leave nothing for the company website.
 * A Worker route is evaluated BEFORE the origin, so only /FeedQualityApp/* is
 * intercepted and the apex stays unclaimed: the placeholder A record can be
 * repointed at a real site later without touching anything here.
 *
 * GitHub Pages remains the one and only build. Every deployment still goes
 * through the full CI gate -- lint, typecheck, unit and contract tests,
 * Playwright on the real base path, and the bundle credential scan -- and this
 * Worker adds no second build path that could bypass it.
 *
 * The app is built with base '/FeedQualityApp/' (see .github/base-path), so
 * the HTML it serves asks for /FeedQualityApp/assets/..., which maps back onto
 * the Pages path below. The two must agree; changing one without the other
 * yields a blank page.
 */
const ORIGIN = 'https://thestormkingg.github.io/bff-sample-testing';
const PREFIX = '/FeedQualityApp';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) {
      // The apex and every other path belong to whatever the DNS record points
      // at. This Worker deliberately claims nothing else.
      return new Response('Not found', { status: 404 });
    }

    // Without the trailing slash the browser resolves ./manifest.webmanifest
    // against the parent directory and the manifest and icon 404.
    if (url.pathname === PREFIX) {
      return Response.redirect(url.origin + PREFIX + '/' + url.search, 301);
    }

    const upstream = await fetch(ORIGIN + url.pathname.slice(PREFIX.length) + url.search, {
      method: request.method,
      headers: { accept: request.headers.get('accept') ?? '*/*' },
      redirect: 'follow',
    });

    const response = new Response(upstream.body, upstream);

    // Assets carry a content hash in their filename and may be cached hard.
    // index.html must not be: a stale copy would reference asset hashes that
    // no longer exist after a deployment, and the operator would get a blank
    // screen with no error. Revalidate it on every load.
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      response.headers.set('cache-control', 'no-cache');
    }
    return response;
  },
};
