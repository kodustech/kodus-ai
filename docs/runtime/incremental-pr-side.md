# Incremental PR side: apply the diff to main's prepared state (2026-11-23)

Status: design, no code. Written from a measurement on a customer monorepo (a Nuxt app, Firebase functions and a
dashboard) and from the code of this branch (`b79342337`). A line marked "unverified" was not run or not read to the
end.

**Question.** Today every PR Run rebuilds the PR side and exports a whole new image. On a large monorepo that does not
fit the 45 minute boot. When the PR changes no dependency or build input, can the PR side start from the state main
already prepared, apply the diff, rebuild only the workspaces the diff touches, and run?

**Answer.** Yes, for the docker-gvisor path, with one change of mechanism from the question: do not start from main's
*machine*. Start from main's *baked generation* (immutable images the cell already holds), copy only the touched
workspace directories out of it into a per-claim directory, apply the diff there, run the recipe's rebuild command for
those workspaces in a throwaway container, and boot the PR's services from the baked image with that directory mounted
over the workspace. No image is built or exported for the PR side. Anything the rule does not cover, or any failure,
falls back to today's full build. It reopens a decision of
[monorepo-speed-and-targeting.md](monorepo-speed-and-targeting.md) (Decided 2, section 6 below).

Terms are in [glossary.md](glossary.md). Related: [fork-from-checkpoint.md](fork-from-checkpoint.md) (same direction,
for resets and the Firecracker path), [build-cache.md](build-cache.md), [environment-setup.md](environment-setup.md).

## 1. The measured problem

All numbers are from the customer test (two EC2 t3.xlarge, 4 vCPU, 16 GB, one with the hub and worker, one with the
gVisor cell). No name of the customer or the repository is kept here.

| Measure | Value |
|---|---|
| Boot cap of one Run | 45 min (`apps/runtime/src/worker/run/run-orchestrator.ts:120`, `RUN_TIMEOUT_MS`) |
| Customer's CI, same repo, prepares and builds | 7.1 min (npm install 2.2 min, functions build 4.9 min) |
| Cell, setup of the big workspace, best case | 34.6 min (npm install 9.6, Prisma + cookbook + functions 19.1, context + patch 5.9) |
| **Image export alone**, 150 of 160 steps cached | **30.8 min** in the setup, **20 to 31 min** for a PR |
| `COPY . .` of the repo | 6 to 14 min |
| Rebuild of the functions workspace on the cell | 20.7 min (CI: 4.9 min) |
| A smaller app of the same repo, state on and cache valid | 5 min 44 s (23 min 38 s before the cache was valid); of that: Nuxt build 2 min 25 s, repo download 27 s, context 18 s, copies 17 s, export 12 s |
| Cold PR build of the small app | 17.6 min: export 5.8 min (2.1 GB of layers), npm ci 4.5, base image pull 2.7, Nuxt build 2.5, moving layers through the registry 2 |
| Main side, from the saved image | 6.6 s |

Reading it:

- For the small app the cache works; the monorepo-speed plan is right for it.
- For the big workspace the cache does not help where the time is: with 150 of 160 steps cached the export still takes
  20 to 31 minutes. Why unchanged layers cost that much is **unverified**: the registry path is meant to move only
  layers the Docker lacks (`registry.go:17-30`), and a whole-tree walk under gVisor is a known cost of stock BuildKit
  (`environment-setup.md` section 4). Step 0 attributes it. Either way, a PR build there is the functions rebuild (20.7) plus the export (20 to 31) plus the context (up to 14):
  41 to 66 minutes, over a 45 minute cap, however well the layers are ordered.
- Nobody has attributed the 4x between the CI's 4.9 min and the cell's 20.7 min functions build (4 vCPU shared with the
  builder's own limits, gVisor, a cold framework cache, or the install being re-run are all possible). **Unverified.**
  It decides whether a functions PR fits at all (section 8, step 0).

## 2. How a PR side boots today

One Run acquires two claims, base and PR, each its own set of machines on its own claim network (D3: both from the
same environment image, `fork-from-checkpoint.md`).

1. **Workflow.** `bootSides` (`run-orchestrator.ts:905`, called at `:2018`) acquires both sides. The request carries
   `ref: {side, sha}` and a key per side (`acquireRequest`, `:201-219`). The PR's first acquire waits for the base's to
   start (`:316-360`), because two builds at once race for the cell. A PR from a fork gets `forkPullRequest: true`
   (`:218`).
2. **Cell, prepare** (`apps/runtime-cell/internal/agent/prepare.go:26-46`): network, machines, code, upload, compose,
   egress, recipe steps, observer SQL, running. A PR claim's machine is tainted at once (S-52: destroyed on release,
   never baked, snapshotted or pooled; `prepare.go:192-193`).
3. **Code** (`prepare.go:194-270`): the cell downloads the head's tarball by API, extracts it with no network, revokes
   the token, then lays Kody's authored files and the default branch's recipe over it.
4. **Compose `Up`** (`internal/drivers/dockergvisor/up.go:25-46`): sandbox, build, coverage, render, pull, data, up,
   record. The step that matters is `build` (`up.go:257`, `build.go:68`).
5. **Build, per compose build section** (`build.go:68-178`):
   - the fingerprint is a hash of the whole build context (minus the ignore file), the Dockerfile, target, args and
     builder image (`internal/buildfingerprint/fingerprint.go:54`, `Of`; no fingerprint above 200 000 files or 4 GiB,
     `:22-26`);
   - a fingerprint equal to one the baked generation holds takes that image by tag (`build.go:112-130`,
     `bakecatalog.Generation.Images`, `catalog.go:56`). That is the main side's 6.6 s;
   - otherwise BuildKit runs. A PR that changes any file of the context changes the fingerprint of **every** service
     whose build uses that context, whether or not the file belongs to that service. A dashboard PR rebuilds the
     functions image too.
6. **BuildKit** is a rootless builder container under runsc on the claim network (`dockercli.go:797-890`,
   `buildOnce` `build.go:676`). Its state is a reflink view of the environment's state (`buildstate/store.go:1-21`,
   `clone_linux.go:17-31`), read-only for a PR (only a default-branch setup seeds, `build.go:314`). It runs the
   Dockerfile: install (cached), `COPY . .`, the build.
7. **Export.** The built image has to reach the cell's Docker, which is the engine that runs the containers. BuildKit
   keeps its own store, so the image is pushed to a registry container of the build and pulled by digest, or, when that
   registry was never seeded, written as a `type=docker` tarball and `docker load`ed (`registry.go:17-30`, `build.go:463-472`).
   Every layer the engine lacks is written and read again; what makes this 20 to 31 minutes with most steps cached
   is not attributed yet (section 1).
8. **Run.** Data (golden copy), compose up, health check (`environment-runtime.ts:256-268`), the round snapshot
   (`run-orchestrator.ts:304-313`).

**Why the export exists.** It is a transport between two image stores (the builder's and the engine's), not isolation
and not immutability. The two sides stay apart by their own claim networks, containers and per-claim directories, and a
baked generation is immutable because the catalog never rewrites it (`bakecatalog/catalog.go:2-10`). Nothing in the
export protects anything. It disappears when nothing is built, which is what makes the idea possible.

## 3. Design

### 3.1 Where the diff is applied

- **A. Main's live machine: no.** It carries the base claim's canaries, placeholders and process state, and a
  checkpoint of it is admitted only as that claim's own round (`fork-from-checkpoint.md` section 2.1). The PR would
  mutate what it is compared against.
- **B. A checkpoint: not on docker-gvisor.** One checkpoint cannot be forked into two claims and the app restarts
  anyway (`fork-from-checkpoint.md` section 2.2). On Firecracker the template already is this (section 7).
- **C. Main's baked generation: picked.** Immutable images and golden data the setup published, already on the cell and
  already what main boots from. The PR side adds a per-claim directory on top; nothing is written to the generation.
  The baked image is a read-only lower and every container made from it has its own writable layer. The design never
  tags, commits or pushes over a baked image (tested, step 5).

### 3.2 The path, step by step

On a PR claim whose environment has an `incremental` declaration (3.5) and a generation with a source manifest (3.6):

1. **Diff by content, on the cell.** Compare the PR checkout the cell just extracted with the generation's source
   manifest (path, type, mode, sha256). The hub's changed-path list is not trusted: the Git API list is capped, and a
   wrong list tests main's code under the PR's name. The comparison is against the *baked tree*, so main having moved
   after the bake shows up as more changed files, which is correct.
2. **Decide** (3.3), a pure function of the diff and the checkout: `full` plus a reason, or the touched workspaces and,
   per compose service, `reuse the baked image` (its workspace closure is untouched; today's whole-context fingerprint
   would rebuild it) or `rebuild`.
3. **Stage.** `docker create` from the baked image (not started), `docker cp` each touched workspace directory to
   `claim/incr/<service>/<workspace>`, apply the diff there (3.4).
4. **Rebuild** each touched workspace with the recipe's command in a one-shot builder-class container of the baked
   image: runsc, claim network, mirror-only egress, a build's memory, CPU, pid and disk limits and disk watch
   (`watchBuildDisk`, `build.go:746`), the staged directory mounted over the workspace path, no org secret.
5. **Start.** The cell rewrites the compose file so the service uses the baked tag with the staged directory bind
   mounted over each touched workspace path, and `render` re-checks it as any file (`up.go:25-46`). Data, up and the
   health check are unchanged.
6. **Record** `incr.diff`, `incr.stage`, `incr.rebuild` phases and `bootPath: incremental` (3.7).

Not in the path: BuildKit, the registry, `docker load`, `COPY . .`, a new image.

**Why a directory and not a thin image or `docker commit`.** A thin `FROM baked` image with the delta `COPY` and a
`RUN rebuild` reuses today's build code and is the smallest change, but pays the export again unless the exporter moves
only new layers; the measurement does not say. A `docker commit` depends on runsc's rootfs overlay keeping writes where
Docker's diff sees them, which a file-backed overlay may not. Both **unverified**, cheap to test (step 0). The
directory costs the size of the touched workspaces, not of the image. Recommendation: the directory, unless step 0
shows the thin image's export is proportional to the delta; then ship the thin image first.

### 3.3 The decision rule: incremental eligible

Conservative: any line that is true forces the full build, with its reason recorded.

**Full, by path** (any changed, added, deleted or renamed path that matches):

- Dependency inputs at any depth: every `package.json` (even a script change: `postinstall` and `prepare` are build
  inputs), `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, `.yarnrc*`, `.npmrc`,
  `.pnpmfile.cjs`, `patches/**`, `.yarn/**`, and the equivalents of other stacks the recipe builds (`go.mod`, `go.sum`,
  `requirements*.txt`, `poetry.lock`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`).
- Image inputs: a Dockerfile or ignore file of a build section, a compose file of the recipe, `.kodus/**`, the recipe's
  `incremental.full_when` globs.
- Build configuration: `tsconfig*.json`, `babel.config.*`, `.babelrc*`, `next.config.*`, `nuxt.config.*`,
  `vite.config.*`, `webpack.config.*`, `turbo.json`, `nx.json`, `project.json`, `.nvmrc`, `.node-version`,
  `.tool-versions`. The recipe may add to this list, never shorten it.
- Generator inputs: `*.prisma`, `*.proto`, `*.graphql`, `openapi.*`, `codegen.*`, `drizzle.config.*`, unless the
  recipe's `incremental.generates` names them as covered by `rebuild`.
- A path in no workspace and in no declared source directory (root and CI files): **global**, so full (monorepo-speed
  uses the same word, section 2.3 there).
- A symlink, hard link, device, FIFO, `..` path or `.git` entry (the extractor refuses most; apply checks again).

**Full, by size:** more than 2000 changed files, 50 MB changed, 3 touched workspaces, or a manifest past the
fingerprint's own bounds (200 000 files, 4 GiB, `fingerprint.go:22-26`).

**Full, by absence:** no `incremental` declaration; no source manifest or a missing image (`ErrBakeDataUnavailable`,
`build.go:119-124`); the recipe digest differs from the generation's; build `secrets` or `args` that depend on the
claim; the environment is off (brake, 3.7, or the hub).

**Workspaces, from manifests only:** npm and yarn: the root `package.json` `workspaces` (array or `{packages}`), globs
over directories holding a `package.json`; pnpm: `pnpm-workspace.yaml` `packages` with `!` exclusions. Edges are
`dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies` that name another workspace
(`workspace:*`, `file:`). A path belongs to the deepest workspace directory holding it. **Touched** = workspaces with a
changed path plus their reverse closure (as Vercel and Nx select affected projects, monorepo-speed 2.3). Turborepo
and Nx are not oracles: both sit on the same `package.json` workspaces. Nx projects defined only by `project.json`,
Lerna-only layouts and Bazel are not read: their files are on the full list and their paths are global. A repository
with no workspaces is one workspace rooted at the repository, eligible only with a declared `rebuild`.

The graph is the one monorepo-speed 2.3 designs (`libs/runtime/planner/workspace-graph`, TypeScript, not built). The
cell is Go and cannot import it, so it has its own reader and **both are held to one fixture set**, as recipe parsing is
in both languages (`recipe.ts:13-19`, ENV-08). Decision D3.

### 3.4 Applying the diff

Applied to the staged copy, never to the generation or to the image:

- Added and changed regular files are copied from the PR checkout with the open flags `O_NOFOLLOW`, regular files only,
  and the destination resolved inside the staged workspace directory (the same checks `tarball` and `checkoutfs`
  apply on the way in). Deleted paths are removed, so a file the PR deleted is gone. A rename is a delete plus an add.
- Modes are copied. A diff touching a path outside the touched workspaces is a bug in the decision; the apply step
  refuses it and the claim falls back to full.
- Cost: reading the diff's files and one `docker cp` of each touched workspace. No size is paid for untouched
  workspaces or for the root `node_modules`.

### 3.5 How only the touched workspaces rebuild: the recipe declares it

The cell must not guess the rebuild command: reading `package.json` scripts is a guess about what the Dockerfile ran,
and a wrong guess serves stale output under the PR's name. **The recipe declares it, the author writes it, the setup
proves it.** In `.kodus/workspace.yaml` under `services` (`libs/runtime/protocol/recipe.ts:165`, a `strictObject`; the
Go recipe in `internal/recipe` and `fixtures/recipes` change with it):

```yaml
services:
  incremental:
    web:                                   # a compose service with a build section
      root: /app                           # where the repository sits in the image
      rebuild: pnpm --filter {name} build  # run in root once per touched workspace; {name}, {dir} filled in
      outputs: ["{dir}/.output"]           # paths written besides {dir} itself
      full_when: ["scripts/gen-*.mjs"]     # extra globs that force a full build
      generates: []                        # generator inputs that `rebuild` covers (3.3)
```

The author's checks (where the Node install order is checked, `authored-files-policy.ts` `checkNodeBuild`):

- `rebuild` must be a command of a `RUN` in that service's Dockerfile (same words after the placeholders), so the
  declaration cannot drift from what the image did. A build that is not one repeatable command per workspace gets no
  declaration and always builds in full.
- `rebuild` must not install dependencies and has only the mirror as egress.
- `outputs` are relative to `root`, inside the workspace or declared source directories.
- No inference when absent: today's environments are untouched. First release: Node workspaces only (what was measured).

### 3.6 What the baked generation must keep

`bakecatalog.Generation` (`catalog.go:56`) holds `Images` and `Volumes`. Add a **source manifest** per generation: a
file next to the catalog (not inside the 4 MB catalog JSON, `catalog.go` `maxBytes`), written by the setup's bake
before the generation is published, one sorted record per file (path, type, mode, sha256), bounded by the same limits as
the fingerprint. It is immutable with the generation and removed with it (`Prune`). Cost: one pass over the checkout the
setup already walks to fingerprint. Without it a PR cannot be compared and goes full, with the reason `no_manifest`;
generations baked before the change never become incremental until the next bake (a setup is a user action today, so
the first incremental Run follows the first re-bake: fork-from-checkpoint.md section 1.1, last row, says the same of
templates).

### 3.7 How the result stays as trustworthy as a full build

An incremental build is wrong when something a full build recomputes was not recomputed.

- **A dependency, lifecycle script or toolchain moved:** the force-full list. The baked install is main's, and the PR
  proved it did not touch the inputs.
- **Generated code:** generator inputs force full unless `rebuild` covers them; the self-test checks the generated
  paths exist after a rebuild.
- **Build caches the full build had:** the rebuild runs on the baked image, which holds no cache mounts, so the
  framework cache starts cold. Slower, never wrong.
- **A workspace the closure missed** (a relative import out of a package, a shared directory that is not a package):
  not visible to a manifest graph. The self-test and the shadow check exist for this; the import graph
  (`routesReaching`) is a later fallback.
- **The apply copied less than the PR has:** after apply, the staged workspace's file hashes must equal the PR
  checkout's for every path under it, not only the diff. A mismatch falls back.
- **The rebuild wrote old output** (an output missing from `outputs`): every declared output must exist and be newer
  than the apply.

**Setup self-test.** After the setup's full build at commit C and before the generation is published, the cell runs
the incremental path on C with a synthetic one-file change in each declared service's workspace, boots it, and requires
health and the declared outputs. A service that fails keeps no declaration (`not_proven`, shown on the environment
screen). One extra rebuild per service, once.

**Shadow check.** For one Run in N (default 20), after the verdict and off the critical path, a build-only claim runs
the full build for the same head and compares file manifests of the declared outputs (paths, sizes; content where the
build is reproducible). A divergence is stored and shown. **Brake:** two divergences in the last ten shadows set the
environment `incremental: off` until a person turns it on. Its cost counts as a prebuild's does (monorepo-speed 1.4 D).

**What the verdict says.** The Run page and comment show `boot path: incremental (workspaces: web)` or `full (reason:
lockfile changed)`, so a reader knows which build a verdict stands on.

### 3.8 Security: the diff is untrusted code

- **What runs PR code:** the rebuild command, as a Dockerfile `RUN` does today: a builder-class container under runsc,
  claim network, mirror-only egress, claim limits, no org secret, never the observer. The machine is already tainted
  (S-52). Nothing new runs outside a container.
- **Main's state:** the generation is read with `docker create` and `docker cp` from a stopped container. The incremental
  path never retags, commits, pushes or removes a baked image, and holds the generation for the claim's life
  (`holdGeneration`, `build.go:76-84`), so a later bake cannot remove it underneath. The base side's containers use the
  same image with their own writable layers; the sides share no directory, network or volume.
- **The shared cache:** an incremental claim has `Seeds=false` always, mounts no build state or exported cache (there is
  no BuildKit in this path), pushes nothing to the environment's registry, and writes only under `claim/incr/`, removed
  with the claim. The default-branch setup stays the only writer of anything kept (S-52).
- **Paths:** the staged directory is a child of the claim's work directory, `0700`; the compose rewrite accepts bind
  sources only under it and `render` rejects the rest (`up.go:25-46`). Apply opens with no-follow. A symlink that came
  from main's image is main's and is never followed.
- **Disk:** staged and rebuilt bytes are bounded and watched like a build's output (`watchBuildDisk`, `build.go:746`).
- **Fork PRs:** unchanged: no org secrets, no approved egress hosts. Eligibility is not widened for forks.
- **For the P3 security review:** the one new bind mount of host files into an app container (cell files and the decoy
  are bind mounted already: `env_run.go`, `decoy.go`).

### 3.9 The fallback

Falls back to the full build, recorded with a reason code (`bootPath: full`, `fallbackReason`), when:

- the rule says full (3.3), or the generation or its manifest is unavailable;
- any incremental step fails: stage, apply, verify, rebuild non-zero, output missing, disk bound, health check never
  passes within the Run's share of the budget;
- the brake has the environment off.

The fallback is the unchanged path (`build.go:68`), so nothing about it needs to be trusted again. **Time budget.** The
45 minute boot is one budget. An incremental attempt gets at most 10 minutes or a quarter of what is left, whichever is
less. A rebuild that fails because the PR's code does not compile is the PR's failure, but it cannot be told from an
incremental artifact failure without a full build: so after the attempt fails, the full build runs if the time left
fits its last measured duration for this environment; otherwise the Run ends with the build error as the blocker and
`incremental unconfirmed`, never as a verdict about the PR. Decision D6.

### 3.10 Optionally start on push

That is the prebuild of monorepo-speed 1.4 D (setting, 90 s debounce, 25% machine-minute share, hit-rate brake), not
duplicated here. With this design a prebuild is a diff plus a rebuild, minutes of machine instead of an image export, so
its cost bound is much easier to meet. Build it last (step 10).

## 4. What changes, by place

- **Recipe** (`libs/runtime/protocol/recipe.ts`, Go `internal/recipe`, `fixtures/recipes`, JSON Schema):
  `services.incremental` (3.5), strict, both parsers, same fixtures. The recipe author writes and checks it and bumps
  `RECIPE_AUTHOR_REVISIONS` (reauthor) so existing recipes are asked once.
- **Protocol** (`libs/runtime/protocol/messages.ts`, Go `internal/hubprotocol`): `AcquireRequest.incremental?:
  'auto' | 'off'` (policy and kill switch); claim progress and ready carry `bootPath`, `fallbackReason`,
  `touchedWorkspaces` and the incremental phases. Additive and optional: an old cell ignores it and boots full.
- **Worker** (`apps/runtime/src/worker/run/`, `env/`): sets `incremental` per org and environment from the release
  track (never PostHog), keeps `bootPath` on the Run next to the build steps (`build-steps.ts`), stores divergences,
  applies the brake.
- **Cell**: bake keeps the source manifest and runs the self-test (`bake.go`, `bakecatalog`); a new `incremental` step in
  `Up` before `build` (`dockergvisor/incremental.go`); `prepare.go` passes the manifest and policy into `Up` (checkout,
  taint and egress unchanged); `build` skips what the step handled.
- **Web**: the Run page and comment show path and reason; the environment screen shows `incremental: on / off /
  not_proven`.

## 5. The metric that proves it

**Primary: PR-side boot time**, from the PR claim's acquire to `claim.ready`, split in the phases the cell already
reports (`timing.phases`, `driver.go:121-187`) plus `incr.diff`, `incr.stage`, `incr.rebuild`; p50 and p90 per
environment and per boot path, on the Run page.

**Corpus 1, kr-shop** (four features, each a PR with a planted bug and a correct PR with the same description,
`intent-oracle.md:5`). Too small to prove speed; it proves **correctness**. Pass: each PR gets the same verdict and
findings on the incremental path and on the forced full path (`incremental: off`), 4 of 4 bugs found and 4 of 4 correct
PRs clean on both, and `bootPath` is `incremental` for source-only diffs. Two PRs are added: a lockfile change and a
Dockerfile change, which must report `full` with the right reason.

**Corpus 2, a big monorepo fixture** generated by a script (no customer code): a pnpm workspace with 3 apps (server
rendered web, Node API, functions-like) and a shared package, public dependencies over 1.5 GB of `node_modules`, a
Dockerfile of the shape the author writes. PR cases: source change in one app, in the shared package, lockfile,
Dockerfile, a 3000-file change, a deleted file, a generator input.

Targets, on a 4 vCPU, 16 GB cell like the measured one (targets until measured):

| Case | Today | Target |
|---|---|---|
| Source change, web app | 17.6 min cold, about 6 min with valid cache | at most 5 min p50 |
| Source change, shared package | not measured | at most 8 min p50 |
| Source change, functions workspace | 41 to 66 min, does not fit | at most 25 min p50 (fits if its rebuild is 20.7 min or less) |
| Lockfile, Dockerfile, generator input | as today | `full`, reason recorded |
| Verdict parity, corpus 1 | n/a | 100% |
| Shadow divergences | n/a | 0 in the first 100 before widening past alpha |

## 6. Why this reopens a decision

[monorepo-speed-and-targeting.md](monorepo-speed-and-targeting.md) Decided 2 (`:546`) rejects "apply the changed files
over main's image" (reasons at `:98-120`): a compiled frontend would serve main's old output, and a second boot path
needs a detector whose wrong answer tests main's code under the PR's name. Two things changed. First, its premise (the
install layer is a cache hit, only `COPY . .` onward rebuilds) holds for the small app and not for the big workspace,
where the export of unchanged layers dominates; its section 1.2 candidate 2 (moving the image into Docker) was a
hypothesis and the measurement is consistent with it (the cause inside the export is still to attribute, step 0). Second, both objections are answered: the touched workspace's own build
runs, and the detector is the force-full list of 3.3 backed by the apply verification, the self-test and the shadow
check of 3.7. It is reopened for the measurement, with a gate (step 0). If the functions rebuild alone does not fit,
the benefit is the web and API apps only, and continuing is the owner's call (D1).

## 7. Out of scope here

- **Firecracker.** The PR side restores the environment template and builds in the VM's own dockerd or the kit's
  buildkitd (`microvm/build.go:1-40`, `env_run.go:53-57`). The export that costs 20 to 31 minutes is a docker-gvisor
  transport between two stores; the VM path was never run on this repository (`fork-from-checkpoint.md`). Protocol and
  recipe changes are shared, so an in-VM variant can follow.
- **The base side when main moved past the bake**, and **resets** (fork-from-checkpoint's subject).

## 8. Build plan

Each step starts with the test that fails first. Steps 1 to 4 are pure; step 0 is the only one that needs a cell.

0. **Measure, no product code; gate for the rest.** On a cell with the big fixture: (a) the PR side's phases and
   `build.cache.input`; (b) the functions-like rebuild alone, in a container of the baked image; (c) `docker cp` of one
   workspace out of the baked image; (d) export of a thin `FROM baked` image with a 1-file `COPY`, by registry and
   tarball; (e) whether `docker diff` sees files written under runsc. Output: a committed table, the mechanism (3.2),
   and whether the functions case fits.
1. **Tree manifest and diff** (Go, `internal/incremental/tree`). Fails first: two fixture trees give the exact added,
   changed (content, mode), deleted and renamed sets; a symlink, FIFO and `..` path are refused; a tree over the limit
   is `ErrTooBig`; an unreadable file is an error, never skipped.
2. **Workspace graph and decision** (Go `internal/incremental/decide`, TS reader of monorepo-speed 2.3, same fixtures
   under `fixtures/workspaces/`). Fails first: npm, yarn and pnpm layouts; a source change gives its app; a shared
   package gives its dependents; each force-full path of 3.3 gives `full` with its reason; a path in no workspace is
   global; both readers agree on every fixture.
3. **Recipe field** (TS, Go, fixtures, JSON Schema). Fails first: both parsers accept the field and reject unknown keys,
   an absolute `outputs` path, an installing `rebuild`; the author check refuses a `rebuild` that is not a Dockerfile
   `RUN` and passes one that is.
4. **Source manifest in the generation** (`bakecatalog`, `bake.go`). Fails first: a bake publishes it with the
   generation, a prune removes it, a crash between the two leaves no eligible generation without it, a generation
   without one returns `no_manifest`.
5. **The driver step** (in-memory Docker). Fails first: a source-only diff boots with no build call, registry push or
   `docker load`; recorded calls show no `tag`, `commit`, `push` or `rm` on the baked image and its listing is
   unchanged; `Seeds` is false and no state or cache directory is touched; the staged directory goes with the claim;
   an untouched service takes the baked tag; a failure at stage, apply, verify, rebuild or output falls back to
   `build` once with the reason; a disk bound stops the rebuild; a path outside the touched workspaces is refused.
6. **Protocol and worker** (TS and Go). Fails first: acquire and ready round-trip the new optional fields in both
   languages; an old cell's ready is read as `full`; the Run projection shows `bootPath`; only the alpha track gets
   `auto`.
7. **Trust: self-test, shadow, brake.** Fails first: a setup whose rebuild leaves an output missing publishes with
   `not_proven`; a shadow whose manifests differ stores a divergence; two in ten turn the environment off and a person
   turns it on; no shadow runs on a fork head still awaiting approval.
8. **Live check on the dev cell** through the product (`@kody runtime`, then the screens), not a queue harness: the
   targets table and verdict parity with the fixture and kr-shop, then the customer's repository read-only.
9. **Release** on the alpha track for one org, shadow at 1 in 5, widening after 100 clean shadows.
10. **Prepare on push** (3.10), separate plan.

About 22 engineer-days before step 10 (a model, not a measurement).

## 9. Open decisions, with a recommendation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Reopen monorepo-speed Decided 2 (apply the diff over main's baked image) | **Yes, gated on step 0** (functions rebuild measured, mechanism chosen). If the functions workspace cannot fit, continue only for the web and API apps. |
| D2 | Mechanism: per-claim directory over the baked image, or a thin derived image, or `docker commit` | **Directory over the baked image.** Ship the thin image first only if step 0 shows its export is proportional to the delta; it is the smaller change. Do not use `docker commit` unless `docker diff` is proven under runsc. |
| D3 | Who decides eligibility and finds workspaces | **The cell, from content**, with a Go reader held to the same fixtures as the TS graph. Not the hub's changed-path list (capped, and a wrong list is a false verdict). |
| D4 | Rebuild command: inferred or declared | **Declared in the recipe**, written by the author, checked against the Dockerfile, proven by the setup self-test. Never inferred at run time. |
| D5 | Ship the first release with the shadow check | **Yes, at 1 in 5 on alpha**, 1 in 20 later. It is the only measure of trust that does not depend on the author's rules being right. Without it the first release has no proof beyond the self-test. |
| D6 | Failure of the incremental attempt | **Full build if the time left fits it**, otherwise end with the build error and `incremental unconfirmed`, never a verdict about the PR. Attempt budget 10 min or a quarter of what is left. |
| D7 | Caps (2000 files, 50 MB, 3 workspaces) and the default force-full list | Accept as first values; they are mine, not measured. Tighten from the `fallbackReason` counts. |
| D8 | Base side and Firecracker | **Later.** Not in the first release. |
| D9 | Framework cache for the rebuild (cold today) | **Cold at first.** If the rebuild is the long pole after step 8, keep a per-environment cache directory written only by the default branch's setup and read as a reflink view, the buildstate rule for a new directory (`buildstate/store.go:1-21`). |
| D10 | Where the first measured repository is run | The customer's repository only after the fixture passes, read-only, per the rule that validation reads customer data and never changes it. |
