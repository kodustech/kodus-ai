# Benchmark Farm

Run the 50-PR code-review benchmark for **a branch's compiled engine** on a
remote droplet, so you can iterate on the engine without the Mac choking on a
local stack — and run several branches **in parallel** to compare variants.

## Why a droplet (and why "build on droplet")

The review worker is **I/O-bound** (it waits on the LLM, CPU idle). So the Mac's
problem isn't compute — it's that it can only run *one* stack, making experiments
serial. Move each variant to its own cheap droplet and they all wait on the LLM
concurrently: wall-clock for N variants ≈ 1× a run, not N×.

**Option A — build on droplet, no registry.** Each slot droplet gets the
branch's *source* and builds the **compiled artifact** (`node dist/…`, via
`docker-compose.bench.yml`) locally. No GHCR push in the loop. `branch = variant`.

> Not watch-mode (a headless droplet edits nothing — watch is just overhead and
> flakiness) and not prod config (we run the dev `.env` + local DBs). It's the
> compiled artifact with benchmark config.

## Model

A farm **slot** (`a`, `perf-v2`, …) = a self-hosted instance named `bench-<slot>`
→ droplet `kodus-selfhosted-bench-<slot>` (covered by the existing
`kodus-selfhosted-*` destroy safety prefix). State / SSH keys / secrets all reuse
`scripts/selfhosted/` (`~/.kodus-dev/config`, `DIGITALOCEAN_TOKEN`).

Each concurrent slot needs its **own forked repo-set** (5 repos × 10 PRs) — the
webhook on a repo can only point at one droplet. See `project_matrix_repo_independence`.

## Commands

```bash
# 1. create a bare droplet (Docker + cloudflared, no stack)
scripts/benchmark/farm/bench-up.sh a

# 2. ship a branch's source + build the compiled stack on it
scripts/benchmark/farm/bench-sync.sh a my-engine-experiment
#    re-run with another branch to swap the variant (layer-cached, faster)

# 3. poll from the Mac while a run is in flight
scripts/benchmark/farm/bench-status.sh a

# 4. tear down
scripts/benchmark/farm/bench-down.sh a
```

Compare two variants in parallel:

```bash
scripts/benchmark/farm/bench-up.sh a && scripts/benchmark/farm/bench-up.sh b
scripts/benchmark/farm/bench-sync.sh a branch-A
scripts/benchmark/farm/bench-sync.sh b branch-B
```

## Env knobs

| Var             | Default                  | Meaning                                  |
|-----------------|--------------------------|------------------------------------------|
| `BENCH_DO_SIZE` | `s-4vcpu-8gb`            | droplet size (build needs RAM/CPU)        |
| `BENCH_ENV_FILE`| `<repo>/.env`           | the `.env` shipped to the droplet (gitignored, so not in the source archive) |

## What's wired vs. pending

**Wired:** droplet lifecycle (`up`/`down`), branch → compiled running stack
(`sync`, health-gated), remote status. The webhook ingress is just the droplet's
public IP:`3332` — no nginx/wildcard.

**Pending (next):** the tenant + PR step — onboard the benchmark tenant + repo-set
on the droplet (reusing `tests/e2e/benchmark/provision-repos.ts` + the
trial→byok→migrate-to-free→finish-onboarding dance), point that repo-set's
webhooks at the slot's IP, then fire the 50 PRs via
`scripts/benchmark/benchmark-suite.sh` and judge. PR creation + judging run from
the Mac (pure GitHub API); only `wait-for-run.js` reads the droplet's Mongo.
