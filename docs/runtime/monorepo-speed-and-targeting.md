# Monorepo speed and targeting

Status: design, no code. Written 2026-11-22 from a customer test on a large monorepo (a Nuxt app, Firebase functions and
a dashboard). Three product problems, one design each:

1. A Run took 23 minutes; the review took 1 min 10 s. The PR side is slow.
2. The recipe author booted the easiest app; most PRs touch the apps that got no environment.
3. A finding that mixes the change the PR describes with a bug it does not describe points at the whole object.

Priorities, in order: performance, security, low cost. Everything below was read in the code on this branch
(`origin/kody-runtime/pr`, `b53d5aa30`); a line that says "unverified" was not.

## What the test measured

| Part | Time | Source |
|---|---|---|
| Main side, from the saved image | 6.6 s | the test |
| PR side, whole | about 22 min | the test |
| PR side, measured build steps | about 3.8 min, `nuxt build` 2.4 min | the test (BuildKit steps) |
| PR side, not attributed | about 18 min | the test |
| Their own CI e2e | 18 min | the test |
| Kody review | 1 min 10 s | the test |

The 18 minutes are the whole problem and nobody knows what they are. Section 1.2 lists what the code says they can be;
none is confirmed.

---

## 1. A faster PR side

### 1.1 Today

- **The PR side builds; the main side does not.** A claim's build takes the baked image when the build's fingerprint
  matches one the default branch baked (`apps/runtime-cell/internal/drivers/dockergvisor/build.go:53-128`). The
  fingerprint hashes the whole build context (minus the ignore file), the Dockerfile, target, args and builder image
  (`internal/buildfingerprint/fingerprint.go`, `Of`). Any source file change that is not ignored changes it, so every
  code PR builds. Main's 6.6 s is that reuse.
- **A build that has to run is BuildKit with layer cache.** The recipe author is told to copy manifests and the lockfile
  first, install, then `COPY . .`, and to put package and compile caches in `RUN --mount=type=cache`
  (`libs/runtime/api/application/recipe-author/recipe-author.agent.ts:410-418`, "Every pull request rebuilds the image,
  so write it to build fast"). A refusal check enforces the monorepo install order (`authored-files-policy.ts:307-313`,
  `checkNodeBuild` `:668`). So "do not reinstall when the lockfile did not change" is already how the Dockerfile is
  written: the install layer is a BuildKit cache hit, and only `COPY . .` and what follows rebuild. That is what Docker
  documents: "a change causes a rebuild for steps that follow", and a cache mount keeps a package cache across builds
  ([Docker, optimize cache](https://docs.docker.com/build/cache/optimize/)).
- **The layers only come back if the state or an exported cache exists.** The build state (BuildKit's whole root per
  environment, layers and cache mounts) is read by every non-default build through a copy-on-write view. It is **off by
  default**: `-gvisor-build-state` is `false` (`apps/runtime-cell/cmd/cell/config.go:381`). Without it, BuildKit imports
  and exports a local zstd cache (`environment-setup.md` section 4; `docs/runtime/build-cache.md` section 1). Cache
  mounts are never exported by any BuildKit exporter ([moby/buildkit#1512](https://github.com/moby/buildkit/issues/1512),
  cited in `build-cache.md` section 2), so with the state off every cache mount is empty on every PR build. The test's
  note "BUILD_STATE was off" matches this flag.
  The dev cell script (`apps/runtime-cell/scripts/dev-gvisor-cell.sh`) turns it on by default (`BUILD_STATE=0` opts
  out) and, at start, prints whether the state's filesystem has reflinks (XFS with `reflink=1`, or btrfs; without them
  the cache is slow) and how much disk is free against `-gvisor-build-state-min-free-gb` (20 by default, set with
  `BUILD_STATE_MIN_FREE_GB`), warning when free space is under the floor plus a 20 GB margin: a cell under the floor
  drops the cache right after seeding. A customer test measured 23 min cold against 5 min 44 s with the cache.
- **Framework build caches are not in the author's rules.** The mount list is "Go /go/pkg/mod and /root/.cache/go-build,
  npm, pnpm store, Yarn Berry, Yarn 1, pip" (`recipe-author.agent.ts:414`). Nothing names `.next/cache`, `.nuxt`,
  `node_modules/.vite`, `.nx/cache` or `.turbo`. Next.js documents `.next/cache` as the directory to persist between CI
  builds ([Next.js CI build caching](https://nextjs.org/docs/app/guides/ci-build-caching)). For Nuxt, Vite and Nx I did
  not read a primary source for the cache paths: unverified, to be read before they go into the prompt.
- **Where a boot's time is already measured.** A claim's boot reports `BuildSteps` (steps, cached, slowest steps) and
  `Phases` (each build's base image pull, RUN, COPY and export parts, moving the image into Docker, compose up, first
  healthy answer; at most 8, slowest first) (`apps/runtime-cell/internal/driver/driver.go:121-187`). The worker keeps
  only `BuildSteps` per side for the Run page (`apps/runtime/src/worker/run/build-steps.ts:25-35`, 8 slowest). The 3.8
  minutes are those steps. The 18 minutes are outside them.
- **Planning already overlaps the PR build.** The plan starts once the base is ready and the PR build has started, and
  the base side plays each probe's first round meanwhile (`apps/runtime/src/worker/run/early-plan.ts:1-35`). Nothing is
  left to overlap there.
- **A Run starts on push only in `rules` mode.** The webhook records every PR event for the Runtime
  (`libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts:321`). `decideRun` returns
  `on_request_only` for the `on_request` mode and runs only in `rules` mode, with `runOnNewPushes`, `runOnAgentPullRequests`
  and the rules' `changed_paths`, `label`, `files_changed` conditions (`libs/runtime/api/domain/trigger-rules.ts:156-166`;
  called at `pull-request-trigger.use-case.ts:424`). A new repository starts `on_request` (`create-environment.use-case.ts`,
  `turnOnIfUnset`). There is no debounce anywhere on the PR path (searched `libs/runtime/api` and `apps/runtime/src`);
  a newer head cancels the live Run (`pull-request-trigger.use-case.ts`, `superseded`).
- **Cost bounds that exist:** `RUNTIME_MACHINE_MINUTES_PER_ORG_DAY` (default 10 000, `libs/runtime/environment/machine-minutes.ts:12`),
  10 asked Runs per PR per day (`trigger-rules.ts`, `COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY`), the LLM budgets
  (`libs/runtime/api/domain/budget.ts`), and `RUNTIME_SETUP_PER_ORG` setups at a time (default 2).

### 1.2 Where the 18 minutes can be (unverified, in the order to check)

The Run's claim carries `timing.phases`; the cell logs `build.cache.input mode=<cold|exported|remote|state>` and
`build.builder_log`. Nobody has read them for this Run. Candidates, each with the log that settles it:

1. **The exported-cache import.** State off means `build.cache.input mode=exported`: BuildKit imports a `mode=max`
   local cache. A `type=local,mode=max` export alone took 127 s in one public report
   ([build-push-action#1054](https://github.com/docker/build-push-action/issues/1054), cited in `build-cache.md`), and
   an import re-checks every blob. A monorepo's install layer is the largest blob. Settle with `build.cache.input` and
   the phases' import part.
2. **Moving the image into Docker.** A build that finds the environment's registry never seeded sends an uncompressed
   `type=docker` tarball that the cell `docker load`s (`registry.go:88-96`, `build.go:270-290`). A Nuxt monorepo image
   with a full `node_modules` is gigabytes. Settle with the phases' "moving the image into Docker" and `image_load`.
3. **Waiting for room.** A boot waits up to 30 minutes for a cell (`environment-setup.md` section 2) and setups and Runs
   queue per org. Settle with the run's capacity-wait step (`apps/runtime/src/worker/run/run-capacity-wait.spec.ts`
   covers the path) and the claim's queue time.
4. **A cold install.** If the lockfile changed, or the state was evicted (`build.state.missing`, `stateEvictedAt`), the
   install runs: the author's own text says more than half an hour for a large monorepo.

No design below depends on which one it is, except the order of work: step 0 reads the Run's phases first.

### 1.3 Options

**(a) "Do not build when the PR does not touch dependencies; apply the changed files over main's image."**

- For an **interpreted** app (a Node server run from source, Python, PHP, Ruby, a dev-server recipe), the image after
  `COPY . .` holds sources and the start command reads them. Copying the changed files over the baked image gives the
  same result as rebuilding, in seconds.
- For a **compiled frontend** (Nuxt `nuxt build` then `node .output/server/index.mjs`, Next `next build`, Vite build) the
  served artifact is the build's output. Applying changed sources over main's image serves main's old output. The build
  has to run. This is the customer's app (the author is told to run the production server for apps with pages,
  `recipe-author.agent.ts:380`), and it is where the 2.4 minutes are.
- An overlay mode would also be a second boot path next to the recipe's: the PR would run something the recipe does not
  describe (a new build, new env, a changed Dockerfile is exactly what a PR can change). It would need its own
  "did this PR change the Dockerfile, the compose file, the recipe, the lockfile, a build config" detector, and a
  wrong answer there is a Run that tests main's code under the PR's name. Rejected as a build path.
- What survives from (a) is what the cell already does: layers keyed by content. A PR that changes no dependency
  manifest takes the install layer from BuildKit's cache and rebuilds only from `COPY . .`. And a PR that touches only
  paths outside the app (docs, another app) is a **targeting** question, answered in section 2 (no Run for an app the PR
  does not reach, as Vercel and Nx do: [Vercel skipping unaffected projects](https://vercel.com/docs/monorepos),
  [Nx affected](https://nx.dev/docs/features/ci-features/affected)).

**(b) Always reuse the dependency layer by lockfile, rebuild only the app build, and keep framework caches in the
state.** This is what the cell is built for; it fails on three counts: the state is off by default, the framework cache
directories are not mounted, and nothing measures where time goes. Chosen (section 1.4).

**(c) Move the whole cache off the cell (registry).** `build-cache.md` section 3 already chose it as the target for
eviction survival; it brings layers, not cache mounts. Needed for the evicted-state case, not for this problem. Left to
that plan.

**(d) Start building on push instead of on `@kody runtime`.** Two sub-cases:

- `rules` mode already runs the whole Run on push, with `runOnNewPushes`. No code needed; the customer sets it. What it
  lacks is a debounce (a burst of pushes cancels a half-built Run each time, `superseded`) and a visible cost bound.
- `on_request` mode: nothing starts until someone asks. A **prebuild**: build the PR side's image on push, keep it, let
  the later `@kody runtime` reuse it. It spends machine minutes on PRs nobody asks about. Needs a bound.

### 1.4 Chosen design

**A. Turn the state on and prove it (config, no code).** Enable `-gvisor-build-state` on every cell whose work directory
is on XFS or btrfs (reflink views; `build-cache.md`, `environment-setup.md` section 4). Where the filesystem has no
reflinks the overlay view runs a build that replaces a file again without the state (`config.go:381`): those cells stay
as they are until they have XFS. The disk floor and the evicted-state ledger already exist (`build-cache.md` sections 1
and 4).

**B. Framework caches in the author's rules and a check.**
- Add to the mount list in `recipe-author.agent.ts:414`: `.next/cache` (Next), the Nuxt build cache directories (read
  the Nuxt docs first, unverified), `node_modules/.vite`, `.nx/cache`, `.turbo`. Say "mount the cache of the framework
  that builds the app, in the RUN that builds it".
- Bump `RECIPE_AUTHOR_REVISIONS` (`libs/runtime/run/recipe-author-version.ts`) with `reauthor: true`, so existing
  recipes are rewritten once (the mechanism in `environment-setup.md` section 3). A revision that forces a rewrite
  costs one author run per environment (up to 400k tokens); the customer's recipe is one of them.
- A deterministic check in `checkNodeBuild` (`authored-files-policy.ts:668`): a Dockerfile that runs `nuxt build`,
  `next build`, `vite build`, `nx` or `turbo` in a `RUN` without a `--mount=type=cache` for that framework's directory
  is refused with the line and the fix. Same pattern as the Nx check (`:727-740`).
- Trust model: the state is written only by the default branch's setup; a PR reads a throwaway view
  (`build-cache.md` section 1). A framework cache written under `--mount=type=cache` inherits that: a PR cannot poison
  the next PR's cache, the CREEP and GitHub cache-poisoning rule (`build-cache.md` section 2). Framework caches are
  content-keyed by the framework; a stale entry is a cache miss, not a wrong build (Next documents the directory as
  safe to persist). Unverified for Nuxt and Vite.

**C. Attribute every minute.** Report **all** phases of a boot, not the 8 slowest steps, for a PR side slower than a
threshold (say 5 minutes): the worker keeps `timing.phases` and `build.cache.input mode` per side on the Run, shown on
the Run page next to `buildSteps` (`build-steps.ts` and the projection). The Run's own comment says "the PR side took N
minutes: X building, Y moving the image, Z waiting for a cell" when it is over the threshold. No guess ever again.

**D. Prebuild on push, bounded, for `on_request` repositories (and a debounce for `rules`).**
- *Setting:* a repository setting `prebuildOnPush` (off by default; shown only where the org is released to the Runtime
  and the repository has an `active` environment). Same trust and permission rules as the Run settings (Manage over the
  environment's repositories).
- *Trigger:* the PR event path (`pull-request-trigger.use-case.ts`, `decide`). On `opened`, `reopened`, `ready_for_review`
  and `synchronize`, after the same gates as a Run that has nothing to do with rules: not draft, not a closed PR, fork
  policy (a fork's head is never prebuilt unless the environment's policy would start it, ADR-030, `decideForkRun`),
  bot authors off unless `runOnAgentPullRequests`, and at least one changed path under an app the environment boots
  (section 2). A PR whose paths no app reaches is never prebuilt.
- *Debounce:* a prebuild starts after the head has been quiet for 90 seconds (a DBOS durable sleep keyed by PR; a newer
  `synchronize` restarts the wait and cancels a build in flight for the old head; `closed` cancels). The window is a
  worker constant, not a setting. Reason: pushes arrive in bursts and each build is minutes of a machine.
- *What it does:* a build-only claim on the cell: it fetches the PR head's code the way a Run's PR side does (same
  token, same sandbox, same egress policy, no org secrets, no recipe steps), runs only the build sections, and keeps the
  resulting images under `prebuilt/<env>/<headSha>/<recipeDigest>` with a 2 hour TTL and the disk floor's order. It
  starts no service. When the later Run's PR side builds, the fingerprint lookup (`build.go:53-128`) is extended with
  the prebuilt generation for this head: a match is a tag, as the baked image is today. A prebuild that did not finish
  by then is not waited on (the Run builds as it does today and the prebuild is cancelled); a prebuilt generation for
  another head or recipe digest is never taken (the fingerprint decides, not the name).
- *Cost bound:* three limits, all counted in machine minutes through the existing admission store: (1) one live
  prebuild per PR and per org at a time, setups first (it queues behind `RUNTIME_SETUP_PER_ORG`), (2) a daily share of
  the org's `RUNTIME_MACHINE_MINUTES_PER_ORG_DAY`: prebuilds may use at most 25% of it, the remainder is for setups and
  Runs, (3) a **hit-rate brake**: a repository whose last 20 prebuilds were used by a Run less than 30% of the time stops
  prebuilding until someone turns it on again, and says so on the settings screen. A repository nobody asks about
  therefore costs at most 20 prebuilds, not one per push forever.
- *`rules` mode:* the Run already starts on push. It gets the same 90 s debounce (a Run on a head that moved within 90
  seconds waits), which saves the cancelled builds; no prebuild.
- *Threat model:* a prebuild runs a PR author's Dockerfile on push, with no one having asked. Today an `on_request` repo
  runs nothing until a writer asks, and `whoCanAsk` gates it (`askPermission`). A prebuild moves that moment earlier, so
  the controls are: (i) forks and agents as above, (ii) the build runs where Runs' builds run, under runsc, with the
  egress allow-list and no credential in the build (the builder holds whatever the PR holds,
  `build-cache.md` section 3), (iii) it never writes the state or the exported cache (the PR view is throwaway; only a
  default-branch setup seeds), (iv) the prebuilt generation is keyed by head and recipe digest and is read only by a Run
  of the same PR head, (v) a disk or minute shortfall drops it, never a Run. A PR from an org member is the only author
  whose code builds without a request, which is what `rules` mode already does.

**E. Targets and budget.** The path to a result that arrives with the review needs a number, not a hope:

| Stage (warm environment, state on, lockfile unchanged) | Target |
|---|---|
| Prebuild starts after the quiet window | 90 s after the last push |
| Install layer | 0 s (state view hit) |
| App build (`nuxt build` with the framework cache) | at most 1.5 min (today 2.4 min; the gain is unverified until measured) |
| Moving the image | at most 20 s |
| Boot, ready check, planning (planning overlaps the build) | at most 90 s |
| First probe round and report | at most 90 s |
| PR side from the push, with a prebuild | **at most 5 min, p50** |
| PR side from `@kody runtime`, prebuild ready | **at most 3 min, p50** |
| PR side with no prebuild, state warm | **at most 6 min, p50** |

The review's 1 min 10 s is not reachable for a build-and-boot check: nobody can promise that and it is not promised. The
goal "result with the review" is met as "result within minutes of it, and for PRs that touch no app, none at all".
Success measure: the PR-side median and p90 per environment on the Run page, taken before and after step A.

### 1.5 Tests that must fail first

- `authored-files-policy` spec: a Dockerfile with `RUN npx nuxt build` and no cache mount is refused with the fix; with
  `--mount=type=cache,target=/app/.nuxt` (or the directory read from the docs) it passes. Fails today: no such check.
- `recipe-author-version` spec: the new revision is `reauthor: true` and an environment on the old one is asked once.
- `pull-request-trigger` spec: a `synchronize` on a repo with `prebuildOnPush`, one app touched, enqueues a prebuild
  after the quiet window; a second push inside the window enqueues one for the second head only; a draft, a fork under
  `require_approval`, a bot and a PR touching no app enqueue none. Fails today: no prebuild command exists.
- `run-engine` DBOS spec: the debounce is durable (a resumed workflow does not restart the wait) and a close cancels
  the sleeping prebuild.
- Admission spec: prebuild minutes never exceed 25% of the org's day; with the day exhausted a Run still starts and a
  prebuild does not.
- Hit-rate brake spec: 20 prebuilds, 5 used, the repo stops; a toggle re-enables it.
- Cell test (`build_test.go` family): a prebuilt generation of head A is never reused for head B (fingerprint differs);
  one for head A is reused for head A; a failed prebuild leaves no tag the Run could take.
- Cell test: a build with `-gvisor-build-state` on takes the install layer from the view and the framework cache mount
  from the state (`build_state_test.go` style, with a Next fixture and `.next/cache`).
- Worker spec: the Run's PR-side report carries all phases and the cache input mode; the comment names the largest
  phase when the PR side exceeds 5 minutes.

### 1.6 Effort

| Part | Engineer-days |
|---|---|
| Step 0: read the Run's phases and `build.cache.input` on the cell, answer 1.2 | 0.5 |
| A. State on for XFS cells, measure before and after on the test repo | 1 |
| B. Author rules, framework mount check, revision bump, read Nuxt/Vite/Nx docs | 2 |
| C. All phases and cache mode on the Run page and in the comment | 2 |
| D. Prebuild: setting, trigger, debounce, build-only claim, prebuilt generation, fingerprint lookup, brake, admission share, screen | 10 |
| E. Evals and a live check on the customer's repository | 1.5 |
| **Total** | **17 days** |

---

## 2. Boot the app the PR touches

### 2.1 Today

- **One environment per repository.** `runtime_environments` has `UQ_runtime_environments_org_repo` on
  `(organizationId, repositoryId)` (`libs/runtime/api/infrastructure/runtime-product.models.ts:17`); `create` is
  "idempotent on (organizationId, repositoryId)" (`ports.ts:724`; `create-environment.use-case.ts`, `findByRepository`).
  An environment has one primary repository holding the recipe and members booted beside it, each in `ws/<alias>`
  (`glossary.md`, `multi-repo.md`); `UQ_runtime_environment_repositories_env_repo` allows a repository once per
  environment (`runtime-product.models.ts:80`). So a monorepo is one environment, one recipe
  (`.kodus/workspace.runtime.yaml`, `libs/runtime/contracts/enums.ts:119`), one public service.
- **The recipe author picks the app.** Rules: "Build only the app under test", "Leave out frontends and workers the API
  does not need", "boot that example" for a framework repository (`recipe-author.agent.ts:383-388,404-408`). Nothing
  says which app. The Facts block lists the workspace globs and nothing about which workspace changed (`repository-facts.ts:108-120`).
  The author reads 16 steps and 400k tokens at most (`recipe-author.agent.ts:138-149`); on a large monorepo it
  chooses the app that boots first. That is the test's web app.
- **The trigger already fans out per environment.** A repository that is in several environments gets one outcome per
  environment that triggers on it (`pull-request-trigger.use-case.ts:300-366`, `per_environment`); the run id adds the
  environment's id for a non-primary one (`scope` near the run id in `pull-request-trigger.use-case.ts`). The same repository as **primary** of several environments is
  what the unique index forbids.
- **Everything is keyed by `environmentId`:** setup, bake (recipe digest and commit), the build state (`EnvKey(cell, org,
  env)`, `buildstate/store.go:199`), the exported and remote caches, pool size, kept checks (`IDX_runtime_kept_checks_scope`),
  the screens (`libs/runtime/contracts/views/environments.ts`). A second environment is therefore a second of all of
  them, with no new concept in the cell.
- **The planner has two graph tools.** `libs/runtime/planner/import-graph` is a **file** graph for routes: reverse
  reachability from a changed file to routes, within read, call, byte and time limits, with workspace package resolution
  (`resolve.ts` `packageOf`, `reach.ts` `routesReaching`, `AGENTS.md` "Rules and limits"). It reads files one batch at a
  time through the Git API; it is built for one PR's few unmapped files, not for classifying every PR. It does not
  produce "which app".
- **The trigger rules know paths.** `changed_paths` globs, a linear-time matcher (`trigger-rules.ts` `compileGlob`).
  A customer could write one rule per app today, but a rule only decides whether to run, not which app.

### 2.2 Options

| Option | Gain | Cost / problem |
|---|---|---|
| 1. Tell the author to boot "the app with the most PR traffic" | no code | the author has no PR history; still one app |
| 2. One recipe that boots every app (compose with all services) | one environment | the customer's whole monorepo on every Run: more machine minutes, a bigger failure surface, the author's step limit is why it picks one |
| 3. Several recipes in one environment, picked per PR | no new index | environment-level setup, bake, state and kept checks mix apps: a bake carries one recipe digest; a failed app blocks the others |
| 4. **One environment per app** (relax the unique index to `(org, repo, app_path)`) | every key already exists; bake, state, pool, kept checks, screens separate per app; a failing app does not block another | more setups (bounded by `RUNTIME_SETUP_PER_ORG`), more disk (the state keeps 20 GB per environment, `environment-setup.md` section 4) |
| 5. Pick the app per PR at Run time and build it on the fly, no setup | zero setup | no bake, no state, cold build every PR: 1.2's problem times N |

Option 4. Option 2 and 3 fight the keys; option 5 is the cold build we are fixing.

### 2.3 Chosen design

**Environment = repository + app path.** A new column `appPath` (`''` for today's environments; a repo-relative
directory for an app) and the unique index `(organizationId, repositoryId, appPath)`. An environment with an `appPath`
holds the same repository as primary; its recipe is the committed `.kodus/workspace.<slug>.runtime.yaml` (slug from the
app path, same alias rule as `workspace.ts:14`) or an authored one. Today's environments keep `appPath ''` and the file
names they have. `findByRepository` returns every environment of the repository; callers that assume one are listed
by the compiler (the port returns an array) and each is changed deliberately. The migration only adds a column and
drops and recreates a unique index; no row is rewritten.

**The workspace graph, a new pure module** `libs/runtime/planner/workspace-graph`: input is the repository's manifests
(the root `package.json` / `pnpm-workspace.yaml` globs the Facts block already reads, then each workspace's
`package.json`), output is: the apps (a workspace with a start script or a framework dependency: nuxt, next, vite, a
Nest or Express entry, `firebase-functions`), each workspace's dependencies on other workspaces (`dependencies`,
`devDependencies`, `workspace:*`), and the reverse closure. `packageOf` (`resolve.ts:137`) gives the name and
directory. Manifests only: no source files read, so it costs one tree listing and the manifests, cached per commit like
`ImportGraphCache`. This is what Vercel and Nx do ("the project source code has changed, any of its internal
dependencies has changed, or a lockfile change that only impacts its dependencies": [Vercel](https://vercel.com/docs/monorepos);
Nx selects a task "when your change touches one of its inputs": [Nx](https://nx.dev/docs/features/ci-features/affected);
Turborepo compares base and head and falls back to everything on a shallow checkout:
[Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)). The Git API gives the PR's changed
paths, so the shallow-clone fallback does not apply.

**Which apps a PR touches** = the apps whose directory holds a changed path, plus the apps that depend (transitively)
on a changed workspace package. Not covered by the manifests, so treated conservatively:
- a changed path outside every workspace (root config, `tsconfig.base.json`, CI files): *global*; every app with an
  environment is touched, up to a cap of 3 (nearest by dependency, alphabetical after), and the comment says it was cut.
  Vercel treats the same case as "global changes and deploy all applications".
- the lockfile: Nx's default is that it "affects every task" (`projectsAffectedByDependencyUpdates` limits it). The first
  version treats a lockfile change as global. Resolving which workspaces' dependencies moved needs a lockfile parser per
  package manager; not built here, and the cap keeps the cost down.
- a shared directory that is not a workspace package (`../shared`, imported by relative path): the manifests do not see
  it. The import graph (`routesReaching`) is the fallback, called only for changed paths that fall in no workspace, with
  its existing limits. If it cannot say, the path is global.
Used both by the trigger (section 2.4) and by the prebuild (section 1.4 D).

**The recipe author is told which app.** The setup request for an environment with `appPath` carries `targetApp:
{ path, name }`. The author's first message gets a Facts line ("Target app: `apps/functions` (`functions`); it depends
on workspaces `packages/shared`; the other apps are out of scope") built by the same no-model facts code
(`repository-facts.ts`), and a prompt rule: "Boot exactly the target app and what it depends on. A recipe whose
public service is another app is refused." A deterministic check (`checkAuthoredSubmission`) refuses a recipe whose
build or start mentions neither the target's path nor its package name (`--filter <name>`, `nx build <name>`,
`WORKDIR`/`COPY` of its path, a compose `working_dir`); it goes back as a tool error naming the line, as the other
checks do. The step limit stays 16: the author no longer explores a whole monorepo to choose, it reads one app. Budget
per setup stays 1.6M tokens.

**Setups per app, cached and reused.** Each app has its own environment: its own default-branch setup, bake, build state,
exported cache and pool (pool size defaults to 0 for an app environment; the org raises it). The install layer is
the same BuildKit layer in each state; two environments of one repository therefore hold it twice. A shared state per
repository was considered and not chosen: BuildKit's root is single writer, and the default branch's setup of one app
would hold the state while another seeds. The duplicated install layer is the price; the disk floor already evicts by
rebuild cost (`build-cache.md` section 1). The remote cache keys on `(org, env, service)` (`build-cache.md` section 4),
so apps do not share it either.

**Creating them.** An admin adds an app from the repository's environment screen ("Add an app"): a list from the
workspace graph (apps only), one click each, which creates the environment and asks for its setup. For the first Run of
a PR that touches an app with no environment, the trigger does not create one on its own (setup is an admin's opt-in:
`turnOnIfUnset`, "Set up is the opt-in"): the comment lists the apps the PR touches that have none, with the link.
Reason: a setup spends model tokens (up to 1.6M) and machine minutes.

**What the customer sees when an app cannot boot.** Each environment's setup already ends in a typed blocker with a card
(`libs/runtime/blockers/catalog.ts`). Added: the Run's comment has one line per touched app, always:
- booted and checked (the Run's normal report),
- "not set up: add it" (no environment),
- "setup failed: <card title>, <fix>" (blocker, from the last setup),
- "cannot boot in Kody Runtime: <reason>" for a recorded `not_bootable` reason: no HTTP service (Firebase functions that
  need the Firebase emulator suite, a worker, a library), or a boot needing a credential the org has not given. This is
  a new blocker kind with its own card, so it is not read as a failure to fix; it is marked on the environment and the
  Run skips it silently except for that line.
- "not touched": no line (that is the point).
A Run never silently covers less than the PR changed: the sentence "This PR also changes `functions`, which Kody did not
test" is in the comment whenever a touched app has no booted environment. The check title stays about what ran.

### 2.4 The trigger

`decideFor` (`pull-request-trigger.use-case.ts:370`) gets an app filter before the diff-based rules: for an environment
with `appPath`, `diffOf` (already read once for all environments, `:353`) is run through the workspace graph; an
environment whose app is not touched is `skipped` with reason `app_not_touched` (an outcome that is not answered on the
PR for events, and listed for `@kody runtime`'s answer). Today's environments (`appPath ''`) keep the old behavior, so
the web app's environment keeps booting on every PR unless the admin gives it an app path (the screen suggests it when
the graph says the repo is a monorepo). `@kody runtime` with no argument runs the touched apps' environments;
`@kody runtime <app>` is not added (a second command syntax is not needed to fix this problem).

### 2.5 Tests that must fail first

- `workspace-graph` spec (pure): a path under `apps/functions` touches `functions`; a path under `packages/shared`
  touches every app that depends on it, transitively; a root `tsconfig.base.json` is global; a workspace outside the
  globs is global; the cap returns 3 and says it cut.
- `pull-request-trigger` spec: a repo with two app environments, a PR touching only `apps/functions`, enqueues one Run
  and `skipped app_not_touched` for the other; the run id of the second environment differs (`scope`).
- Contract spec: two environments with the same repository and different `appPath` can exist; the same pair twice
  cannot; today's `appPath ''` is unchanged. Fails today: `UQ_runtime_environments_org_repo`.
- Authored policy spec: a recipe that boots `apps/web` for target `apps/functions` is refused; one that runs `pnpm
  --filter functions ...` passes.
- Recipe author eval (the existing eval harness): the customer's repository (sanitized, no customer data in fixtures,
  see the standing rule) with each of the three apps as target; the recipe boots that app or says `not_bootable`.
- Report spec: a PR touching `functions` and `dashboard` with only `dashboard` booted names `functions` as untested.
- Blocker catalog spec: `not_bootable` has a card with no "fix" that retries.

### 2.6 Effort

| Part | Engineer-days |
|---|---|
| Migration, store, port to an array, every `findByRepository` caller | 3 |
| `workspace-graph` module and tests | 3 |
| Trigger app filter, global cap, reasons | 2 |
| Author: target in the request, Facts line, prompt, check, version bump, evals | 4 |
| `not_bootable` blocker, comment lines, environment screen ("Add an app", graph list) | 4 |
| Live check on the customer's repository, three apps | 1.5 |
| **Total** | **17.5 days** |

---

## 3. Separate the described change from the undescribed one

### 3.1 Today (read in the code)

- **The compared fields.** `normalizeFields` flattens the JSON body into one field per value, to depth 8, and
  **an array is one field**: `flatten` descends only into plain objects; arrays and values go to `JSON.stringify`
  (`libs/runtime/gate/probe-fields.ts:54-65`, "below MAX_FLATTEN_DEPTH a subtree is one field"; `isPlainObject` excludes
  arrays, `:41`). So `applinks.details` is one field whose value is the whole array; its first element's `appIDs` and
  `paths` are inside that string. The finding's name is `json.applinks.details` for that reason.
- **The explanation by the PR's text.** An assertion reads paths (`intentAssertionReads`,
  `libs/runtime/contracts/probe-assertions.ts:416`: `equals` reads its path; `every` an array; `status`; `includes`
  nothing). `readsEveryDifference` keeps only paths whose segments are all strings and turns them into `json.a.b`
  names; a field is explained when it equals such a name or starts with it plus `.`
  (`libs/runtime/gate/stated-intent.ts:167-187`). An assertion `$.applinks.details[0].appIDs` has a number segment,
  so it is dropped from that list (the doc says it too: "A path through an array index reads one element, never the whole
  array", `intent-oracle.md`). The differing field `json.applinks.details` is then not read by any assertion: the
  decision stays `behavior_change` and `decideStatedIntent` returns it unchanged (`:287-292`).
- **The count in the comment.** "N of M assertions from what the PR describes held" is `intent.held`/`intent.assertions`
  (`libs/runtime-publish/domain/render-runtime-comment.ts:1017`). It counts assertions, not differences. A held
  assertion next to a finding on the same probe reads as a contradiction: the assertion held on the leaf it reads; the
  finding is about the rest of the array.
- **What the comment names.** `pathLine` prints `differs in <fields>` from `differingFields` (capped at 5 names,
  `libs/runtime/run/run-report.ts:126`), with main's and the PR's status, not their values (`render-runtime-comment.ts:590-610`).
  The values are on the finding card's Response tab: `responseDiffOf` shows each differing field's two values, cut to 200
  characters, and "nothing here reaches the PR comment (ADR-052)" (`libs/runtime/run/response-diff.ts:1-6,76`). For
  the array field the value is the whole array's JSON, cut to 200 characters.
- **Not a fix of its own:** the diff-spelled explanation (`intended-change.ts`) explains only string literals the diff
  removes and adds in one block, and never non-strings (`:12-30`); an array of objects is not one.

### 3.2 Options

| Option | Effect | Problem |
|---|---|---|
| 1. Flatten arrays too (`json.a.details[0].paths[0]`) in `normalizeFields` | one field per leaf everywhere | every consumer of field names changes: the base-variance mask (`stability.ts`), history, kept checks, the intended-change lookup, the field limit (5 names, 20 fields), the stored `fields.json` of old Runs; a big list becomes thousands of fields; a version bump of `RUNTIME_RELEASE_VERSION` and a re-baseline of kept checks |
| 2. A leaf diff computed **after** the gate, from the two values it already holds | no change to fields, masks, history; old Runs unaffected | a second structure next to `differingFields` |
| 3. Ask the LLM which part is described | | the oracle's rule 4: no LLM in the verdict |

Option 2.

### 3.3 Chosen design

**One pure function** `leafChanges(base: string, pr: string): LeafChange[]` in `libs/runtime/gate` (a new file next to
`intended-change.ts`): both arguments are the whole-value JSON strings the gate already stores per field. It parses both
(a value that does not parse as JSON is one leaf, the whole field, as today), walks objects by key and arrays by index
to the leaf, and returns for each differing leaf: its path (`applinks.details[0].paths[0]`), the base value, the PR value,
and whether it was added, removed or changed. Limits: depth 16 and 200 leaves per field (what is cut is counted:
`truncated`). Arrays are compared **by index first**; an array of the same elements in another order is one change of
kind `reordered` (the code already knows this case: `reorderedAsStated`, `stated-intent.ts:226`), never N leaf changes.
Values are cleaned the way `responseDiffOf` cleans them (`clean`, secret-looking keys always `[redacted]`, 200
characters), reusing `maskNested` and `isSecretPath` from `response-diff.ts`, so a leaf diff can leak nothing the
Response tab does not already show.

**It never invents a path or a value.** Every leaf is a difference between the two stored strings of two rounds the gate
compared. A field the base itself varied on is masked (`maskedFields`) and is not walked: a leaf under a masked field
(or under a masked leaf path) is left out. The leaf diff runs on the PR's first healthy round and the base's first
healthy round, the same rounds `responseDiffOf` already reads.

**Matching each leaf against what is described.** A leaf is *described* when a passed assertion reads it:
- exactly: an `equals`, `sameAs` or `computed` path equal to the leaf's path, with array indexes as part of the path
  (`$.applinks.details[0].appIDs` reads `applinks.details[0].appIDs` and everything below it, by prefix on whole
  segments);
- by the array rule that exists: an `every` with a length assertion or "only" explains the whole array
  (`explainedArrays`, `:192`), as today;
- by the diff's text: the existing intended-change rule for string leaves (`intended-change.ts`: removed and added in one
  block, distinctive, in code reachable by the route) applied to the leaf's two values instead of the whole field.
Everything else is *undescribed*. Reading is whole segments, never substrings, so `/share/*` cannot be "read" by an
assertion about `shares`.

**What changes in the decision.** Today the gate has one `behavior_change` finding for the probe. New: after
`decideStatedIntent` the decision carries `leaves: { described: LeafChange[]; undescribed: LeafChange[] }` for a
`behavior_change` on a probe that has passed assertions:
- all leaves described: `described_change`, as today (now also reached when the assertion path has an array index,
  because the leaves are what is checked, not the field name);
- some undescribed: stays `finding` / `behavior_change` (never weaker than today), and the finding is the undescribed
  leaves. It is not an `intent_mismatch` (no assertion failed) and the check does not fail on it more than a
  `behavior_change` does today.
- no assertions at all: unchanged field-level behavior, but the leaf paths are still shown (a finding that names
  `details[0].paths[0]` helps even with no stated intent).
It does not change the 5xx rule, the "assertion held on every round" rule or the status rule (`decideStatedIntent`'s own
guards).

**What the comment says.** In place of `differs in json.applinks.details` (`pathLine`), for a finding that carries
leaves:

> `GET /.well-known/apple-app-site-association`: `applinks.details[0].paths[0]` changed from `"/share/*"` to
> `"/shares/*"`. The description only mentions `appIDs`. (1 other change matches what the PR describes.)

Rules for the text, all from data in the Run: the leaf's path and two values (cleaned, cut), the quote's *topic* is not
paraphrased by a model: the clause "the description only mentions X" is built from the paths the passed assertions read
(`appIDs`), never from the PR text. At most 3 undescribed leaves are listed with a "+N more on the Run page"; the
described count is a number. The "N of M assertions held" line is reworded when there is a finding on the same probe:
"M assertions held on the fields they read"; today's text stays for runs without leaves. `ReportPath` gains
`leafChanges` (bounded arrays, `.max(5)` for undescribed, `.max(5)` for described in the stored report), and the
projection and the Response tab show every leaf (up to the 200 cap), grouped described / undescribed. ADR-052's
rule that the Response tab values do not reach the comment is kept for the full tab; the comment carries only the
cleaned leaf the PR author needs, which is the point of this change, so ADR-052 is amended by this document (open
question 6).

**Versioning.** The gate's `fields` and their names do not change. The report gets a new optional field and the comment a
new line shape; a new `RUNTIME_RELEASE_VERSION` (as the oracle's steps did, `intent-oracle.md` "Steps") and no change
for Runs in flight.

### 3.4 Tests that must fail first

- `leaf-changes` spec (pure): `{details:[{appIDs:["A"],paths:["/share/*"]}]}` against `{details:[{appIDs:["B"],paths:["/shares/*"]}]}`
  gives two leaves, `details[0].appIDs[0]` and `details[0].paths[0]`; added and removed elements; a reordered array is one
  `reordered`; a non-JSON value is one whole-field leaf; depth and leaf caps set `truncated`; a secret-looking key is
  `[redacted]` and never appears in the text.
- `stated-intent` spec, the customer's case: assertion `$.applinks.details[0].appIDs == ["B"]` held; the PR also changed
  `paths[0]`: the decision is `behavior_change` with the described leaf `appIDs` and the undescribed leaf `paths[0]`.
  Today it is the same verdict with no leaves. A second case: only `appIDs` changed: `described_change`. Fails today:
  the array-index assertion reads nothing (`stated-intent.ts:167-187`).
- Masked field: a base that varies on `details[1].nonce` yields no leaf for it.
- Segment rule: an assertion on `$.applinks.details[0].appIDs` does not describe `applinks.details[0].appIDsExtra`.
- `render-runtime-comment` snapshot (`render-runtime-comment.spec.ts`): the line above is exact; with no leaves the old
  line is unchanged byte for byte; the "held" line is reworded only with a finding on the probe.
- Redaction spec: a leaf under a key matching the secret pattern prints `[redacted]` in the comment.
- Corpus (`intent-oracle.md` "Done when"): the 20 bug/correct pairs, plus the applinks case: no correct PR flagged, no
  bug lost, and for each bug pair the comment names the undescribed leaf. A regression of any of the 8 kr-shop PRs
  fails the change.

### 3.5 Effort

| Part | Engineer-days |
|---|---|
| `leafChanges` with limits, masking, cleaning, reordered | 2 |
| Leaf matching against the assertions' reads, the diff rule per leaf | 2 |
| Decision and `ReportPath` fields, Response tab grouping | 2 |
| Comment text and snapshots, wording of the "held" line | 1 |
| Corpus run and the applinks case on a real PR | 1 |
| **Total** | **8 days** |

---

## Decided

1. The 18 unattributed minutes are read from the Run's phases before any build change (step 0); the candidates in 1.2
   are hypotheses.
2. No "apply changed files over main's image" build path. The dependency layer is reused by BuildKit's own cache; the
   state is turned on, framework caches are mounted, and the app build is the only thing that reruns.
3. Framework caches live in `--mount=type=cache` and so in the state written only by the default branch (poisoning
   model of `build-cache.md`).
4. Prebuild on push is opt-in per repository, debounced 90 s, bounded by a 25% share of the org's machine minutes, one
   live per PR, and a hit-rate brake at 30% over 20. `rules` mode needs no prebuild, only the debounce.
5. One environment per app: `appPath` on the environment and a unique index on `(org, repo, appPath)`.
6. The app is chosen from a manifest-only workspace graph (reverse dependency closure); the import graph is a fallback for
   non-workspace shared directories only.
7. The author is given the target app and a check refuses a recipe that boots another.
8. Apps are added by an admin; the trigger never creates an environment. The comment always lists a touched app that was
   not tested.
9. The leaf diff is a pure function over the gate's stored field values, not a new flattening; no LLM; described
   against assertions by whole path segments.
10. ADR-052 is amended: the Response tab's values still never reach the PR comment, except the few cleaned leaves a
    finding on an object or array field names (path, main's value, the PR's value, at most 3, secret keys
    `[redacted]`). Recorded where the rule lives, `libs/runtime/run/response-diff.ts` and `run-state.ts`.

### Built (section 3)

`gate/leaf-changes.ts`, `stated-intent.ts` (`leavesOfFinding`, `decideStatedIntent` returns `leaves`), the verdict's
`leafChanges`, the report's `ReportPath.leafChanges`, the comment line and the Run page sentence. Differences from the
text above: the report keeps the undescribed leaves (at most 5) and **counts** of the rest and of the described ones, not
an array of described leaves; the diff-spelled string rule is applied per leaf (`leafSpelledByDiff` in `intended-change.ts`,
same strictness as a whole field) only when no passed assertion reads any leaf of the finding: once the description names
the leaves it means, a sibling the diff also changes (a typo in the same object) stays undescribed. The report also keeps
up to 5 described leaves, each with `by` (`description` or `diff`), and the comment words the undescribed leaf as the
finding ("not described by the PR: ...") followed by "Described and matching the PR: ...", and the held line says the
assertions held "only on the fields they read" and say nothing of the undescribed change; the leaf diff reads the first healthy round of each
side and leaves out a leaf the base's own rounds disagree on, in place of a per-leaf `maskedFields`.

## Open (needs the user)

1. **Is the customer's `functions` in the workspace globs?** Vercel and Nx treat a directory outside the workspace
   definition as global. If `functions` has its own `package.json` outside `workspaces`, section 2's graph cannot see
   it and every path is global until the globs or a repo-level app list say otherwise. Need the repository's root
   `package.json` or `pnpm-workspace.yaml`.
2. **Can Firebase functions boot here at all?** They usually need the emulator suite, which is a download and several
   ports. If not, the customer's functions PRs get "cannot boot" and the value of section 2 is the dashboard and the
   explicit "functions not tested" line. Need one sample run on the dev cell.
3. **Cells without XFS or btrfs.** State on means the overlay view there, where some builds rerun without the state
   (`config.go:381`). Which production cells have reflinks?
4. **The prebuild's share and thresholds** (25% of machine minutes, 30% hit rate over 20, 90 s quiet) are my numbers, not
   measured. Accept as the first values, or give others.
5. **Lockfile changes as global** (capped at 3 apps) is the conservative first version. Worth a per-package lockfile
   reading later?
6. ~~ADR-052 and the cleaned leaf in the comment~~ Decided, see Decided 10.
7. **Where the customer sits in the modes:** if they are on `rules` with `runOnNewPushes`, section 1.4 D only adds the
   debounce for them; if `on_request`, they must opt into `prebuildOnPush`. Which are they?
8. **Nuxt, Vite and Nx cache paths** were not read from a primary source; read them before the author's rule ships.

## Order of work

1. Step 0 (0.5 d): read the test Run's phases and `build.cache.input`; settles 1.2 and which of A, B, D matters most.
2. Section 3, leaf diff (8 d): independent, pure, no infrastructure, fixes a finding a developer cannot read today.
3. 1.4 A and C (3 d): state on where reflinks exist, all phases on the Run page. Measures the next steps.
4. 1.4 B (2 d): framework caches in the author's rules, with the check and the revision bump.
5. Section 2 (17.5 d): `appPath` migration, workspace graph, trigger filter, author target, `not_bootable`.
6. 1.4 D (10 d): prebuild, after section 2 because it needs "which app does this PR touch" and the hit-rate brake
   needs numbers from step 3.
7. 1.4 E: re-measure the table against the same customer repository; the targets stay targets until then.

Total: 0.5 + 8 + 3 + 2 + 17.5 + 10 + 1.5 = about 42 engineer-days (the 17 in section 1.6 includes D and the
measurements already counted here).
