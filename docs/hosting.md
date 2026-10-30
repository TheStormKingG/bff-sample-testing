# Where the application is served from

`https://bountyfarmltd.com/FeedQualityApp/`

## The shape of it

```
browser ──▶ Cloudflare (zone bountyfarmltd.com)
              │
              ├─ /FeedQualityApp*  ──▶ Worker "feed-quality-app"
              │                          └──▶ https://thestormkingg.github.io/bff-sample-testing/…
              │
              └─ everything else  ──▶ the apex A record (placeholder today)
```

## Why a Worker and not a Pages custom domain

A custom domain attached to a GitHub Pages **project** site is served from the
**root** of that domain. Pointing `bountyfarmltd.com` at Pages would hand the
entire apex to this application and leave nothing for the company website.

A Worker route is evaluated **before** the origin, so only `/FeedQualityApp*`
is intercepted. The apex is therefore still free: its A record is a placeholder
(`192.0.2.1`, RFC 5737 TEST-NET-1, proxied) that exists only so Cloudflare
answers for the hostname. Repointing it at a real site later changes nothing
about the application — the Worker route continues to match first.

Requesting the apex today returns a Cloudflare **522**. That is correct and
expected: there is no origin behind the placeholder yet.

## The pieces, and where each one lives

| Piece | Where | Notes |
|---|---|---|
| Build + deploy | `.github/workflows/deploy-pages.yml` | the ONLY build; full CI gate first |
| Public base path | `.github/base-path` | read by the deploy AND by CI's e2e |
| Worker source | `infra/cloudflare/feed-quality-app.worker.js` | **copy** — see below |
| Worker | Cloudflare → Workers & Pages → `feed-quality-app` | |
| Routes | that Worker → Domains | `…/FeedQualityApp/*` and `…/FeedQualityApp` |
| Apex DNS | Cloudflare → DNS → `bountyfarmltd.com` A | placeholder, proxied |
| Auth URLs | Supabase → Authentication → URL Configuration | Site URL + redirect allowlist |

### The Worker source in this repository is a copy, not the deployment

Cloudflare serves what is in its own editor. `infra/cloudflare/` exists so the
code is reviewable, diffable and recoverable, but **editing it deploys
nothing**. After changing it, paste it into the Cloudflare editor and deploy
there. `tests/basePath.test.ts` checks the copy still agrees with
`.github/base-path` and with the Pages origin, which catches the most damaging
kind of drift — a prefix that no longer matches what the app is built for —
but it cannot tell you whether Cloudflare is running this version.

## Things that must change together

- **The base path.** `.github/base-path`, the Worker's `PREFIX`, the Worker
  route patterns and the canonical redirect in `index.html` are one decision in
  four places. The first and the last two are gated by tests; the route
  patterns are not, because they live in Cloudflare.
- **The sheet headers.** Unrelated to hosting, but the same shape of hazard —
  see `verifyWorkbook()`.
- **Auth URLs.** A new public URL must be in Supabase's redirect allowlist
  before anyone signs in on it, or Google sign-in fails with a redirect error.

## The old URL

`https://thestormkingg.github.io/bff-sample-testing/` still answers, because
Pages is still the origin. It serves a build whose assets live under
`/FeedQualityApp/`, which does not exist there — so `index.html` carries a
redirect, scoped to `*.github.io` only, that sends visitors to the canonical
URL with their hash route intact. Without it that URL would render a blank page
rather than fail in any visible way.
