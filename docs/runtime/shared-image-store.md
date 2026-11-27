# Shared image store: build once, share (2026-11-27)

Status: design, no code. Written from the code of the Runtime branch at `31d0ba55a`. A line marked "unverified" was not
measured or not read to the end. Terms: [glossary.md](glossary.md). Related: [e2e-suites.md](e2e-suites.md),
[host-providers.md](host-providers.md), [build-cache.md](build-cache.md), [shared-baked-environments.md](shared-baked-environments.md),
[incremental-pr-side.md](incremental-pr-side.md), [persistent-state.md](persistent-state.md).

## 1. Problem

| Fact | Where |
|---|---|
| A suite PR builds the PR side on every shard host: about 3 x (20 + 10) = 90 host-min, against about 40 as the target | `e2e-suites.md:634`, `:58-72` |
| The cell's PR build measures 17 to 31 min on this monorepo family; CI preps in 7.1 min | `e2e-suites.md:632-634` |
| The template rebuilds the environment although the setup just built it (1h17 measured by the owner; not recorded in the docs) | `build-template.ts:101-117` (a second setup on a second host) |
| boat pools do not use the bake registry, so no host can reuse another host's image | `host-providers.md:594` |
| The pieces exist but are single-purpose: build cache pushed by the default branch's setup only (`cache_remote.go:15-30`), baked images shared by digest, never a PR's (`shared-baked-environments.md` s7), one static credential from a file (`driver.go:114`) | |

Goal: a PR's image is built once and read by the Run and every shard; a setup's layers and images are read by other
hosts and by the template. Nothing about it is visible to the customer.

## 2. Contract

The wire format is the OCI distribution API, which the cell already speaks (`remotecache.Registry`, `PushImage`,
`PullImage`, `share.go:41-42`). A provider differs only in **where the endpoint is and how a credential is minted**.
So the contract has two halves.

**Hub side port, `ImageStoreProvider`** (one per pool, named in the pool like the host class; config only changes):

- `endpointFor(pool)`: URL, CA, region label (internal only).
- `grant(ask)`: `{org, env, scope, mode, claimId, ttl}` returns `{endpoint, token, expiresAt, repos[]}`.
  `scope` is `main` (default branch: layers and images), `pr:<sha>` or `layers` (the build cache); `mode` is `read` or `write`.
- `revoke(claimId)`, `usage(org)`, `gc(org, policy)`, `purge(org)`.

**Cell side:** unchanged client (`Push`/`Pull` by key and digest, every blob checked against its digest), with the
credential taken from the claim instead of `-gvisor-build-cache-remote-auth-file`. New hello feature `imageStoreGrant`;
a hub that does not accept it never sends a grant and the cell behaves as today.

**Types in words:**

| Type | Fields |
|---|---|
| `StoreKey` | org, environment, scope, fingerprint. Extends `remotecache.ImageKey` |
| `ImageRef` | key, manifest digest, bytes, pushedAt, pushedBy claim |
| `StoreGrant` | endpoint, token, expiresAt, repos with `pull`/`push` |
| Hub record `runtime_pr_images` | org, env, prSha, fingerprint, digest, state `pending/ready/failed`, builderClaim, readyAt, expiresAt |

The hub never holds bytes. It holds digests, state and grants.

## 3. Provider implementations

| Provider | Endpoint | Credential | Fits when |
|---|---|---|---|
| **`oci-registry` (now)**: distribution or zot on a long-lived boat machine, local disk, TLS with a certificate the hub CA signs | `https://<store>/` on boat | The hub is the token service (Docker token auth): a short-lived JWT naming repositories and `pull`/`push`; the registry trusts the hub's public key (JWKS) | Hosts run on boat (today) |
| `ecr` (later) | the AWS account's ECR in the hosts' region | `GetAuthorizationToken` under an STS session policy scoped to `o-<h>/*`; 12 h token cannot be shortened, so the session policy and a short role session carry the expiry | Hosts run on AWS (`host-providers.md` 9.3) |
| another host provider's registry (later) | its own | Whatever mints a scoped, expiring token | Hosts run there |

Rule: **the store lives with the hosts.** A pool names its store; a PR's Run and shards are placed in one pool
(`candidate-pools.ts` already keeps base and PR in one pool), so their images never cross providers, and the control
plane (AWS) stores no customer image. Self-hosted cells keep their own registry (`build-cache.md:161`), unchanged.
Customer screens and the PR comment say "prepared once and reused" at most, never a provider, host or region.

The boat store is one machine: no replication. Its loss costs one cold build per environment, never data (images are
rebuildable; data volumes never go in, `shared-baked-environments.md` s7). Disk size, encryption and private networking
on boat are unverified (Open questions).

## 4. Isolation and credentials

**Namespace** (hash of org is its own segment, so an access rule grants one org and nothing more, as in `build-cache.md:149-152`):

```
o-<h(org)>/e-<h(org,env)>/main        default branch images and layers (setup writes)
o-<h(org)>/e-<h(org,env)>/pr-<h(sha)> one PR sha (the PR side's claim writes)
o-<h(org)>/e-<h(org,env)>/cache       BuildKit cache (exists today as e-<h(org,env,service)>)
```

One repository per PR sha because a token scopes repositories, not tags: a shared `pr` repository would let PR A
overwrite PR B's tag. Blobs dedupe across repositories of one org with a cross-repo mount (pull on `main`, push on `pr-*`),
so a PR push sends only changed layers. No cross-org mount is ever granted.

**Who gets what** (minted by the hub with `claim.acquire`, next to `sharedImages`, `claim.service.ts:684,764`; the claim
kind comes from the bound key, `candidate-pools.ts:50-66`):

| Claim | Read | Write |
|---|---|---|
| setup (default branch only, S-52) | main, cache | main, cache |
| template setup host (`template:<org>/<env>`) | main | none |
| Run PR side / suite build claim | main, cache | `pr-<sha>` only |
| suite shard (`suite:<org>/<run>/<n>`) | `pr-<sha>`, main | none |
| main re-run host | main | none |

**Credential rules:**

- Token lifetime 10 min, renewed through the heartbeat while the claim lives; the claim's end stops the renewal. That
  is the revocation: a registry validates a signature, not a denylist, so expiry is short by design. The hub also
  refuses new grants for a claim that ended, and records every grant.
- Delivered to the cell over the existing mutual-TLS channel, held in the cell's memory, never written to disk, never in
  the builder. The builder runs PR code with no process sandbox in BuildKit (`build-cache.md` s3), so it gets no
  credential and no route: the cell moves the files, as `cache_remote.go:23-25` does.
- Scope is computed by the hub from the claim's own bound key, never from a cell's request. A shard's token names its
  own PR repository; another org's repository is a different prefix and is refused by signature, not by convention.
- **Digest pin.** The builder's cell reports `image.pushed {digest}`; the hub records it and gives that digest to the
  shards in `claim.acquire`. A shard pulls by digest (as `share.go:197`), so a tampered tag is useless.
- A PR image is read only by claims of the same org, environment and sha. It is never an input to a setup, a template or
  a main re-run (S-52). A fork PR's image is pushed and read the same way: it is the same code the shards already run, in
  gVisor, and it never receives the org's secrets (`claim.service.ts` `secretsFor`).

**Data at rest and transit:** TLS from the cell to the store, verified against the hub CA (as `cell register`).
Encryption at rest is the store disk's: needs boat's answer (unverified); until then it is the same legal gate as the
template, `admission.allowOrgs` (`host-providers.md:623-625`, `pool.ts:87`). **Audit:** table `runtime_image_store_grants`
(claim, org, env, scope, mode, expiry) and cell events `store.push` / `store.pull` with bytes and ms, no names of files.
**No secrets in images:** the existing rules hold: build secrets are BuildKit mounts, the pre-push scan refuses a layer
holding a claim secret value (`shared-baked-environments.md` s7, `CheckImageSecrets`), placeholders replaced at boot never in a
layer. The PR push uses the same scan with the PR claim's redactor list.

## 5. Flows

```mermaid
sequenceDiagram
    participant E as Suite engine
    participant H as Hub
    participant B as Builder claim (Run PR side)
    participant S as Store (on the hosts' provider)
    participant K as Shard host x3
    E->>H: PR event, plan shards
    H->>B: claim.acquire + grant(main read, cache read, pr-sha write)
    E->>K: start shard hosts from the template (parallel with the build)
    B->>S: pull cache (main)
    B->>B: build PR side (warm layers)
    B->>S: push image to pr-sha (cross-repo mount of main's layers)
    B->>H: image.pushed {digest}
    H->>H: runtime_pr_images ready, digest recorded
    H->>K: claim.acquire + grant(pr-sha read) + digest
    K->>S: pull by digest, check every blob
    K->>K: no build, run the shard's specs
    Note over B: the Run's own probes run on B meanwhile
    K-->>E: results; failed specs re-run on their own host
    E->>H: end, revoke, schedule pr-sha for GC
```

1. **Setup writes main's layers.** Today the default-branch setup pushes the cache in the background
   (`cache_remote.go:140-165`, `build.go:828`) and can push its images (`share.go`). Both stay; the credential becomes a
   grant. The setup's host is not the only reader: any host reads them.
2. **Template reuses the setup's image.** Today `buildEnvironmentTemplate` boots a second setup host and waits for its
   bake (`build-template.ts:102,117`). New: the template host's claim receives `sharedImages` for the fingerprint the
   setup just pushed (the rule "a setup never" at `claim.service.ts:765` changes for the `template:` bound key only),
   pulls instead of building, seeds its data from scratch as today (data never shared), and seals. The `waitForBake`
   contract is unchanged: a bake with `build.done source=shared`. If the pull fails it builds, as today.
3. **The Run's PR side builds once and pushes.** The builder claim pulls main's cache, builds, pushes the PR image to
   `pr-<sha>`, reports the digest. In Run mode this is the Run's own PR claim when its build is the suite's
   (open question 3); in CI mode (no Run) it is a dedicated build claim.
4. **Shards pull, no build.** Shard hosts start from the template at the same time as the build, so host boot is hidden
   behind it. Their `claim.acquire` completes when the digest is `ready`. They run in parallel with the Run's own probes.
5. **Re-run on main** pulls main's image: the template disk already holds it; a template that lags pulls from `main`.
6. **Retention and GC, per org.** `main`: last 2 images per environment (`SHARED_IMAGE_BAKES_KEPT`); `cache`: today's
   eviction plus the registry rule. `pr-<sha>`: deleted by the hub 6 h after the suite run ends (the re-run needs it),
   hard 48 h. A per-org quota (starts at 100 GB, unverified size of one image) refuses a push past it: the PR falls back
   to build. `org.purge` (`persistent-state.md` D13) also deletes `o-<h>/`. The registry's own lifecycle rule is the
   backstop, not the policy.

## 6. Failure modes

Rule: the store only makes things faster. **No store failure fails a Run** (persistent-state D10).

| Case | Behavior |
|---|---|
| Store down or slow; grant mint fails | Claim starts with no grant, builds as today (`build.cache.remote.pull_failed` pattern, `cache_remote.go:99-112`); logged, counted |
| Push fails or secret scan trips | `image.pushed` says `failed`; the hub marks the row `failed` and shards build themselves. Run goes on |
| Shard waits for a digest | Waits at most 3 min after the builder ends or fails, then builds. Never beyond the shard timeout |
| Digest or blob mismatch, manifest not an image | Refused, nothing loaded, build locally, alarm (as `share.go`) |
| Token expired mid-pull | Cell asks for a renewal; if refused, ends the pull and builds |
| Builder host dies | Row stays `pending` until the claim's lease ends, then `failed`; shards build |
| Quota reached | No push; fallback as above |
| Store machine lost | Everything is rebuilt once; no data lost (images and cache only) |
| Old hub or old cell | No grant is sent or understood; today's behavior |

## 7. Contradictions with decided items

| Decided item | What it says | Reason to reopen |
|---|---|---|
| `host-providers.md:594` (8.2) "boat pools do not use [the bake registry]" | boat has no shared image path | The PR build is paid per shard (`e2e-suites.md:634`) and the template rebuilds (1h17). A registry on boat reaches the same goal; the registry itself is the same code |
| `shared-baked-environments.md` s7 "Anything a PR claim built never goes" | PR images never leave the host | New class, never mixed: its own repository per sha, read only by that PR's claims, never by setup, template or main |
| `claim.service.ts:765` / shared-baked s10 "a setup never" gets sharedImages | Only Run builds pull | The `template:` claim must pull to stop rebuilding. Still not a PR claim |
| `build-cache.md:147` "Nothing else pushes" (only the default branch's setup) | Only main writes the store | A PR claim now writes, to its own `pr-<sha>`, never to main or cache. S-52 holds because the PR never writes what main reads |
| `build-cache.md:141` optional basic auth from a file; `driver.go:114` | One static credential per cell | Static credential with write on every org is the wrong shape for hosts that run PR code. Replaced by per-claim grants |
| `host-providers.md:623-625`, s14 item 2 (legal on customer data at rest in boat) | Only Kodus's org on boat until legal signs | Not reversed: the store extends the same gate (`allowOrgs`) to images and layers. Listed so legal sees the larger surface |
| `e2e-suites.md:58-72` step 3 and `:632-634` (15.1 item 2) | Each shard builds the PR side | This design is the "build-once-share step" that item names |
| `host-providers.md:603` previous template as the build source | Setup host created from the previous template | Stays; the image arrives by pull, the template disk still seeds the cache |

Not contradicted, on purpose: persistent-state D4/D9 (data and tool layers stay per cell and per org; data volumes never go
in the store), S-52 (a PR's code never enters a template or main), `build-cache.md` "builder never sees the store".

## 8. Rollout (each step starts with a failing test; sizes are guesses)

| # | Step | Size |
|---|---|---|
| 1 | Store on a boat machine: registry + hub token service (JWKS), TLS from the hub CA, per-org quota; IaC in the infra repo | M |
| 2 | Hub: `ImageStoreProvider` port, `oci-registry` adapter, grant minting from the bound key, `runtime_image_store_grants`, a fake provider and conformance suite | M |
| 3 | Cell: take the grant from `claim.acquire`, renew via heartbeat, drop the auth file; hello feature; old-hub path unchanged | M |
| 4 | PR image: push to `pr-<sha>`, scan, `image.pushed`, `runtime_pr_images`, digest in `claim.acquire` | M |
| 5 | Suite engine: build claim in CI mode, shards start in parallel and wait for the digest, fallback after 3 min | L |
| 6 | Template pulls the setup's image (`template:` claim gets `sharedImages`) | S |
| 7 | GC, quota, purge, retention of `pr-*` | M |
| 8 | Events and the report line; measure on one large monorepo (Kodus's org only, then others after legal) | S |
| later | `ecr` provider when an AWS `perRun` pool exists | M |

Release: steps 3 to 5 change the hello, `claim.acquire` and durable workflows: new `RUNTIME_RELEASE_VERSION`.

## 9. Metrics

Model for a large monorepo, 3 shards, per PR (not measured): build 20 min once on a warm cache, push 2, pull 3 per
shard, Cypress 10 per shard.

| | Today | Shared store | With incremental PR side (build 5) |
|---|---|---|---|
| Host-min | 3 x (20 + 10) = 90 | 20 + 2 + 3 x (3 + 10) = 61 (-32%) | 5 + 2 + 39 = 46 |
| Suite wall | 30 | 35 (shard boot overlaps the build) | 20 |
| Cost at $0.072/h | $0.108 | $0.073 | $0.055 |

Honest read: the store cuts host-min by about a third and does **not** cut wall time by itself (one build is not faster
than three parallel ones). It buys back wall time only with the incremental PR side or by running the Run's probes during
the pull. Target to ship: **host-min per PR at most 65 and wall at most today + 5 min**; reaching about 40 needs
`incremental-pr-side.md`.

How to measure: `machine-minutes` per claim (`pg-machine-minutes.store.ts`) summed per suite run, before and after on the
same repository, alternate PRs by flag; store events give push and pull bytes and ms, hit rate (`source=shared` over
all shard builds), fallback rate, store error rate, time from builder end to last shard start, GC freed bytes, quota use.
Success: hit rate at least 95%, fallback under 5%, no Run failed by the store (zero), pull p95 under 4 min, template
rebuild time down from 1h17 to the pull plus seed (target under 15 min, unverified).

## 10. Open questions for the owner

1. Boat store machine: disk size and encryption at rest, private network between sandboxes, can a long-lived sandbox be
   kept (TTL, plan)? Without encryption at rest, is the legal gate enough?
2. Seed time: how long does the template take to seed data once images are pulled? It decides whether 1h17 falls to 15 min.
3. Is the Run's PR-side image the same as the suite's (`service: e2e`, same compose build)? If not, the suite needs its
   own build claim in Run mode too.
4. Quota and `pr-<sha>` retention (100 GB, 6 h after the run, 48 h hard): accept as first values?
5. Short token (10 min) renewed by heartbeat versus a longer one: is revocation by expiry acceptable, or must the
   registry check a denylist (more moving parts)?
6. Cypress shards that wait for the digest: start hosts with the build (idle host-min, about 3 min each) or after the push (slower)?
7. Fork PRs: push and share their images within the PR as designed, or build per shard as today?
