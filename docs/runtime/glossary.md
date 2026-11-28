# Kody Runtime glossary

Terms used in [environment-setup.md](environment-setup.md), [multi-repo.md](multi-repo.md)
and the Runtime screens, as Kodus uses them.

## Product

- **Run**: one check of a pull request. Two claims (base side, PR side), the probes on each, a verdict and the
  report on the PR.
- **Setup**: builds the environment from its default-branch head, runs the ready check, bakes, and fills the warm
  pool. Runs boot from what it leaves. See [environment-setup.md](environment-setup.md).
- **Recipe**: `.kodus/workspace.runtime.yaml` or `.kodus/workspace.yaml`: the compose files, the public service, its
  health path, the exposed ports, data (migrate, seed) and `services.needs`. Committed, inferred by Kodus, or written
  by Kody.
- **Facts block**: what Kodus reads from the commit before Kody's author starts (package manager, lockfile,
  workspace globs, Dockerfiles, compose files), with no model, and puts in its first message.
- **Repair**: inside one setup, Kody rewrites its own recipe after the boot failed on the recipe's account, and the
  rewrite boots on a new claim (`RUNTIME_SETUP_AUTHOR_REPAIRS`, default 3).
- **Blocker**: why a setup or Run cannot go on: kind, signature, message, and with several repositories the alias.
  The catalog turns it into a card with a title, evidence lines and fixes.
- **Probe**: one check the worker runs on a claim through the hub: an HTTP request, a command (exec) or an SQL
  query. The ready check is a probe.
- **Environment, primary, member, alias**: an environment is the system a PR runs in; the primary repository holds
  the recipe, members boot beside it, each in `ws/<alias>`.

## Infrastructure

- **Cell**: a machine that runs the cell agent (`apps/runtime-cell`) and Docker with gVisor, and boots claims.
  The product screens call a cell a **host** (the server), and its isolated workloads **machines**: one host runs
  many machines, one per side of a Run. "Cell" appears only in code, logs and these docs.
- **Hub**: the service cells connect to (`apps/runtime`, hub). It hands claims to cells and relays probes, bakes and
  pool targets from the worker.
- **Claim**: one lease on a cell: its network, the workload machine and the observer. It has a consumer (`runtime`,
  `setup`, `mcp`, `custom_agent`, `sandbox`), a renewable lease and a hard ceiling (45 minutes for a setup).
- **gVisor / runsc**: gVisor is a kernel in user space that sits between a container and the host kernel; `runsc` is
  its container runtime. Every container on a cell runs under it, the image builder too.
- **BuildKit**: Docker's build engine. A cell starts one rootless BuildKit container per build, under runsc, and
  removes it after.
- **Egress allow-list**: the outbound hosts a machine may reach. Package registries go through the cell's mirror;
  any other host needs an admin's approval; hosts on the platform deny list are never opened.
- **Golden data**: a copy of the database volumes taken on a machine's first boot, restored on each reset instead of
  running initdb and the seed again.
- **Bake**: the cell publishes the setup machine's images (and build caches) as the environment's new immutable
  generation. Only from the default-branch head the product resolved.
- **Warm pool**: machines a cell keeps booted from the bake, so a Run's claim adopts one instead of booting.
- **Cold start / warm start**: cold boots from nothing (build, then up); warm starts from the bake, the build state or
  a pool machine.
- **Snapshot**: a saved state to start from. In Kodus today: the bake (images) and golden data (database files).
  No memory snapshot is used in the product yet; the microVM backend keeps two kinds
  ([isolation-p3-snapshots.md](isolation-p3-snapshots.md)): a **template** (a setup's machine, many machines of its
  org start from it) and a **session** (one machine set aside, restored once).
- **Rebirth**: what the guest's init does in a machine restored from a snapshot before its workload runs again: new
  randomness from the host, the host's clock, new names, ids and address.
- **Checkpoint / restore**: `runsc checkpoint` saves a running container's memory and files; `runsc restore` resumes
  it where it was. Measured on a cell (see measurements), not used in the product yet.
- **Run projection**: the Run as the screens read it (`runtime.runtime_runs` in the Runtime Postgres): one row per
  Run, written by the runtime-worker from the DBOS step of each transition, read by the API with the read-only role
  `kodus_runtime_reader`. The DBOS workflow is the source of truth; the projection is its read model.
- **Prebuild**: an environment built ahead of time, on a push, so a session starts from it (GitHub Codespaces' word).
  Kodus's equivalent is the setup's bake of the default branch.

- **Sandbox**: an isolated machine where Kody or a custom agent runs commands and edits files, on a cell claim of
  consumer `sandbox` ([sandbox.md](sandbox.md)). Not an environment: no compose, no Run.
- **Guest agent**: the process inside a sandbox machine (`cmd/kody-guest`) that runs its commands and file
  operations for the cell over a byte stream, every path opened without following a symlink.
- **OpenBao**: the secret store (open fork of HashiCorp Vault, MPL-2.0). The injector reads a secret from it and adds
  it to outbound traffic for the allowed hosts; the machine only sees a placeholder.
- **Placeholder secret**: the stand-in value a machine sees instead of a real credential; the injector swaps it on
  the way out.

## Builds

- **Layer**: the files one Dockerfile instruction adds to an image. BuildKit reuses a layer while its inputs are the
  same; a changed input rebuilds it and every layer after it.
- **Multi-stage**: a Dockerfile with several `FROM`: compile in a full image, copy only the output into a small
  runtime stage.
- **Cache mount**: `RUN --mount=type=cache,target=...`: a directory BuildKit keeps between builds and never puts in
  the image (package stores, compile caches). Kodus keeps them per environment in the build state. They are not
  exported by `--cache-to` ([Docker docs](https://docs.docker.com/build/ci/github-actions/cache/)).
- **Remote cache**: BuildKit's layer cache exported out of the builder and imported by the next build. A cell uses a
  local zstd cache directory when it keeps no build state; no registry cache.
- **Build state**: BuildKit's own state directory (layers and cache mounts) kept per environment on the cell's disk,
  written by the default-branch setup and read by other builds through a reflink clone (XFS, btrfs) or an overlay.
- **Lockfile / frozen lockfile**: the lockfile pins the whole dependency tree; a frozen install (`npm ci`,
  `pnpm install --frozen-lockfile`, `yarn install --immutable`) fails instead of changing it.
- **corepack**: Node's tool that installs the package manager `packageManager` names. Left unpinned it takes the
  latest release, which is why the checks refuse a bare `corepack enable`.
- **Monorepo prune**: `turbo prune <app> --docker` writes only the manifests and the pruned lockfile (`out/json`)
  and the source (`out/full`) the app needs, so the install layer changes only when they do. pnpm's equivalent is
  `pnpm fetch` on the lockfile alone ([pnpm docs](https://pnpm.io/docker)).
- **Affected**: build or test only the packages changed since a base (`turbo --affected`, `nx affected`). It needs Git
  history; a cell's checkout is a tarball with none, so Kodus does not use it.

## Agents and evals

- **Observation masking**: replacing old tool results in an agent's context with a short stub. Kodus's
  `clearStaleReads` does this to the author's old file reads ([arXiv 2508.21433](https://arxiv.org/abs/2508.21433)
  found it matches summarising at about half the cost).
- **Compaction**: shortening the context by summarising earlier turns. Kodus does not compact the author's context.
- **Prompt caching**: the model provider reuses an already processed prefix of the prompt and bills it lower. Any
  change to an early message breaks the prefix, so `clearStaleReads` clears in batches rather than every step.
- **F2P vs commit rate**: two measures of environment-setup benchmarks
  ([Multi-Docker-Eval, arXiv 2512.06915](https://arxiv.org/abs/2512.06915)). Commit rate: the share of tasks where the
  agent produced an environment image. F2P (fail-to-pass): the share where, in that environment, the tests a fix
  should repair fail before it and pass after. A built environment is not yet a correct one. Kodus's closest
  measures are a setup that becomes active (commit rate) and a Run verdict that matches a PR's known outcome (F2P).
