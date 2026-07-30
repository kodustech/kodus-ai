# Public PR Review API — integration guide

Contract for embedding the "review any public GitHub PR" demo + the
"featured PRs" grid into the marketing site. The demo backend is **API-only**
(no standalone landing). The site renders the UI and talks to these endpoints.

- **Base URL:** the public API host. Locally `http://localhost:3001`; prod is
  the deployed API origin (set it as an env var on the site, e.g.
  `NEXT_PUBLIC_API_URL`).
- **Auth:** none. All `/cli/public/*` endpoints are anonymous.
- **CORS:** the API reflects any origin (`origin: true`), so browser calls from
  the marketing domain work without extra setup.
- **Response envelope:** successful responses are wrapped by a global
  interceptor as `{ data, statusCode, type }`. **Always read `body.data`.**
  Errors may be flat (`{ message, code }`) or wrapped (`{ data: { message, code } }`) —
  read `body.data ?? body`.

---

## Two integration modes

### 1. Featured reviews (instant, cached) — for the grid
Pre-curated real PRs with their review already computed and frozen. Serve
instantly, no waiting, no rate limit. Use these for the "Try a featured PR"
cards and to render a full example review inline.

### 2. Live review (enqueue + poll) — for the "paste a PR" input
User pastes a public PR URL → you enqueue a job → poll until `COMPLETED` →
render the result. Rate-limited and size-capped (see below).

---

## Endpoints

### `GET /cli/public/featured-reviews` — list (grid)
Lightweight metadata for the cards. Returns `{ items: FeaturedReviewSummary[] }`
(inside `data`).

```ts
type FeaturedReviewSummary = {
  slug: string;          // URL-safe id, e.g. "react-fizz-resume-abort"
  tags: string[];        // e.g. ["react","bug","ssr"]
  highlight?: string;    // one-line card copy
  prUrl: string;         // github PR url
  pr: PrInfo;            // PR metadata (owner/repo/#/title/additions/...)
  issuesCount: number;   // how many findings → the "N bugs" badge
  sortOrder?: number;    // lower sorts first
};
```

### `GET /cli/public/featured-reviews/:slug` — full snapshot (detail)
The complete cached review for one card. Render this directly — no job needed.
404 if the slug doesn't exist / isn't published.

```ts
type FeaturedReviewDetail = {
  slug: string;
  tags: string[];
  highlight?: string;
  prUrl: string;
  pr: PrInfo;
  diff: string;          // raw unified diff
  result: {
    summary: string;
    issues: ReviewIssue[];
    filesAnalyzed: number;
    duration: number;    // ms
  };
};
```

### `POST /cli/public/review-pr` — enqueue a live review
```ts
// request body
{ prUrl: string; fingerprint: string }   // prUrl ≤1000 chars, fingerprint ≤256 chars (both required)
```
- `fingerprint` is a stable per-device id you generate client-side (e.g. a
  random uuid persisted in localStorage). It's the rate-limit key.
- On success returns **HTTP 202** with:
```ts
type EnqueueResponse = {
  jobId: string;
  status: string;        // "PENDING"
  statusUrl: string;     // "/cli/public/review/jobs/<jobId>"
  pr: PrInfo;            // PR metadata (show immediately while the review runs)
  diff: string;          // raw unified diff (cache it; pass ?omit=payload when polling)
};
```

### `GET /cli/public/review/jobs/:jobId` — poll
Poll every ~3s until `status` is terminal. Pass `?omit=payload` after the first
poll to skip re-downloading `publicPr`/`publicDiff` (~15 KB) each time.
```ts
type JobStatusResponse = {
  jobId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  result?: { summary: string; issues: ReviewIssue[]; filesAnalyzed: number; duration: number };
  error?: string;
  createdAt: string; startedAt?: string | null; completedAt?: string | null;
  publicPr?: PrInfo;     // present unless ?omit=payload
  publicDiff?: string;   // present unless ?omit=payload
};
```

### Shared types
```ts
type ReviewIssue = {
  file: string; line: number; endLine?: number;
  severity: string; category?: string;
  message: string;            // the finding
  suggestion?: string;        // suggested fix / code
  recommendation?: string;
  ruleId?: string;
};

type PrInfo = {
  owner: string; repo: string; prNumber: number; title: string;
  state?: "open" | "closed"; merged?: boolean; isDraft?: boolean;
  headSha: string; headRef?: string; baseSha: string; baseRef?: string;
  additions: number; deletions: number; changedFiles: number;
  commitsCount?: number; discussionCount?: number; htmlUrl: string;
  author?: { login: string; avatarUrl?: string; htmlUrl?: string };
  body?: string;
  // also optional: reviewers[], checks, commits[], comments[], labels[], assignees[], groupings[]
};
```

---

## Errors (live review)

`POST /cli/public/review-pr` can fail with a typed `code`:

| code            | HTTP | meaning / suggested UX |
|-----------------|------|------------------------|
| `invalid_url`   | 400  | Not a parseable public GitHub PR URL. Show inline validation. |
| `requires_auth` | 400  | PR is private or not found. Pop a "sign up & connect GitHub" CTA. |
| `too_large`     | 400  | Exceeds the free-demo cap. Pop a "sign up for bigger PRs" CTA. |
| `upstream_error`| ~400 | GitHub API hiccup / rate limit. Show a generic retry. |
| `rate_limited`  | 429  | Per-fingerprint cap hit. Body: `{ message, remaining, resetAt, limit }`. Show "you've used your free reviews — sign up", with `resetAt`. |

Error body shape: `{ code, message }` (rate-limit adds `remaining/resetAt/limit`).
Remember to unwrap `body.data ?? body`.

### Limits / caps
- **Rate limit:** 2 reviews per rolling 1-hour window per `fingerprint`.
- **Size cap (`too_large`):** PR must have ≤ 10,000 changed lines
  (additions + deletions) **and** ≤ 80 changed files.

---

## Recommended landing flow

**Grid (featured):**
1. `GET /cli/public/featured-reviews` → render a card per item (`pr.owner/pr.repo`,
   `#pr.prNumber`, `issuesCount` badge, `highlight`).
2. On click → **just link to `https://try.kodus.io/r/<slug>`** (the slug from the
   card). Don't render the review inline on the marketing site — the try app owns
   the result screen. See "Where featured clicks go" below.

   If you ever do want it inline anyway, the data is one call away:
   `GET /cli/public/featured-reviews/:slug` returns the full snapshot
   (PR header + diff + issues), no job, no polling.

**Input (live):**
1. User pastes a PR URL. Generate/persist a `fingerprint` client-side.
2. `POST /cli/public/review-pr` → on 202 you immediately have `pr` + `diff`
   to render the PR while the review runs. Cache `diff` locally.
3. Poll `GET /cli/public/review/jobs/:jobId?omit=payload` every ~3s until
   `COMPLETED` (or `FAILED`), then render `result.issues`.
4. Handle the error codes above (CTA to sign up on `too_large` / `requires_auth` /
   `rate_limited`).

### Where featured (and live) clicks go — one shared screen

The try app already hosts the full result viewer at **`try.kodus.io/r/<id>`**, and
that single route auto-detects what `<id>` is:

- `<id>` is a **UUID** → it polls the live job (`GET .../jobs/<id>`) and shows the
  running → completed review.
- `<id>` is **anything else** → it treats it as a **featured slug** and loads the
  cached snapshot (`GET .../featured-reviews/<slug>`) instantly — no job, no poll.

So the marketing site doesn't need its own result screen or any inline rendering:

- **Featured card click** → navigate to `https://try.kodus.io/r/<slug>`.
- **Live "paste a PR"** → after the `POST` 202, navigate to
  `https://try.kodus.io/r/<jobId>` (the try app polls and renders for you).

The marketing site's only job is the **input box** and the **featured grid**; the
try app owns everything after the click. (If for some reason you want to render a
review on the marketing domain instead of redirecting, every endpoint above is
CORS-open and returns all the data needed — but the default, and what kills the
inline-on-home problem, is to link out to `/r/<id>`.)

---

## Seeding featured reviews to an environment

Featured cards are curated server-side and shipped as a committed snapshot —
the site doesn't create them. For reference (backend ops, not the site):
- `yarn featured-review:promote <jobId> --slug=… --tags=… --highlight=… --sort=N`
  freezes a completed live job into a featured card.
- `yarn featured-review:seed --export` dumps the current featured set to
  `scripts/seed/featured-reviews.json`; `yarn featured-review:seed` upserts that
  fixture into the target env's Mongo (run on deploy so prod serves the same set).
