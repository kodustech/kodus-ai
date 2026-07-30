# Environment variables

All env vars in Kodus flow from **one file**: the `.env.schema` at the
repo root. Everything else — `.env.example`, `.env.template`, the docs
page, the installer template, and your local `.env` — is **generated**
from it. You never hand-edit a generated file; you edit the schema (or
your personal `.env.local`) and let the tooling do the rest.

```
.env.schema  (THE source — edit only this)
     │
     ▼
pnpm run env:apply
     │
     ├─→ kodus-ai/.env.example                       (this repo, OSS / external contributors)
     ├─→ kodus-ai/.env.template                      (1Password injection template, this repo)
     ├─→ docs/_snippets/env-vars-generated.mdx        (this repo, embedded in Mintlify site)
     └─→ kodus-installer/.env.example                 (cross-repo, CI-only on release)

.env.template  ──▶  pnpm run env:pull  ──▶  .env  (gitignored, per-dev)
```

## TL;DR — pick your path

| You are… | Do this |
| --- | --- |
| 🌍 **External / OSS contributor** | `cp .env.example .env`, fill the required values by hand. No 1Password needed. → [details](#oss--external-contributors) |
| 🧑‍💻 **Kodus dev, first time** | Install the 1Password CLI, get vault access, `pnpm run env:pull`. → [setup](#one-time-setup) |
| 🧑‍💻 **Kodus dev, day-to-day** | `pnpm run env:pull` whenever the schema changed (a git hook reminds you after `git pull`). |
| ✏️ **Adding / changing a var** | Edit `.env.schema` → `pnpm run env:apply` → commit schema + generated files. → [guide](#adding-a-new-env-var) |
| 🔑 **Adding / rotating a secret** | Vault item in 1Password + `@sensitive` entry in the schema. → [guide](#adding-a-new-secret) |
| 🛠 **Personal tweak** (ngrok URL, port, `LOG_LEVEL=debug`) | Put it in `.env.local` — wins over `.env`, survives `env:pull`, never committed. → [cascade](#the-cascade--which-value-wins) |

## The files

| File | Committed? | Who writes it | Role |
| --- | --- | --- | --- |
| `.env.schema` | ✅ | **humans, via PR** | Single source of truth: every var, its description, type, default, audience |
| `.env.example` | ✅ | `pnpm run env:apply` | OSS-friendly template — copy & fill by hand |
| `.env.template` | ✅ | `pnpm run env:apply` | 1Password injection template (`op://` refs) used by `env:pull` |
| `.env` | ❌ (gitignored) | `pnpm run env:pull` (or hand-filled from `.env.example`) | Your actual local env. **Never hand-edit if you use `env:pull`** — it gets overwritten |
| `.env.local` | ❌ (gitignored) | **you** | Personal overrides. Wins over `.env` everywhere (app + docker) |

## What goes where

| Kind of value | Lives in | Why |
| --- | --- | --- |
| Real secrets (LLM keys, JWT, OAuth client secrets, etc.) | **1Password** (`Kodus-Dev` vault) | Vary per env, need access control, must be rotatable |
| Normal config (ports, URLs, log levels, queue tuning, crons) | **`.env.schema`** (literal default) | Same value for every dev — versioned in git, single source of truth |
| Local-docker fixtures (`API_PG_DB_PASSWORD=123456`, `RABBITMQ_DEFAULT_PASS=devpass`) | **`.env.schema`** (literal default) | Marked `@sensitive` for typing, but value is public; everyone uses the same. The generator keeps them literal in the template |
| Personal overrides (your preferred port, tunnel URL, `LOG_LEVEL=debug`) | **`.env.local`** (gitignored) | Wins over `.env`. Not committed, not pulled, doesn't touch the schema |

## OSS / external contributors

You don't need (and can't get) access to our 1Password vault — and you
don't need it. The committed `.env.example` is generated from the same
schema internal devs use, so it is always complete and current:

```bash
cp .env.example .env
# fill the required values by hand — comments in .env.example say
# which ones are required and what each var does
```

`pnpm run env:doctor` flags missing required values. For a full local
setup walkthrough see
[CONTRIBUTING.md](../../CONTRIBUTING.md#setting-up-development-environment)
and the
[orchestrator quickstart](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator).

If your contribution introduces a new env var, declare it in
`.env.schema` and run `pnpm run env:apply` (see
[Adding a new env var](#adding-a-new-env-var)) — CI fails the PR
otherwise.

## Internal devs: pulling from 1Password

Internal devs materialize their local `.env` from `.env.template` —
secrets resolve from the **`Kodus-Dev`** 1Password vault. No more "what
value does Gabriel have in his `.env`?".

### One-time setup

1. **Install the 1Password CLI:**
   ```bash
   brew install 1password-cli
   ```
2. **Enable desktop integration** (recommended — skips per-session
   signin): 1Password app → Settings → Developer →
   **"Integrate with 1Password CLI"**.

   Otherwise: `op signin`.
3. **Ask an admin to add you to the `Kodus-Dev` vault.**
4. **Verify:**
   ```bash
   pnpm run env:pull:check
   ```

### Day-to-day

```bash
pnpm run env:pull              # writes .env, backing up any previous one
pnpm run env:pull --force      # overwrites without backup
```

Cheap and idempotent. Run it whenever someone rotates a secret in the
vault — no Slack post needed, no stale `.env`.

A Husky `post-merge` / `post-checkout` hook (`scripts/dev/check-env-drift.sh`)
prints a warning when `.env.schema`, `.env.template`, or `.env.example`
changed in the latest pull or branch switch, so you don't forget to run
`pnpm run env:pull` after picking up a teammate's PR. The hook only **warns**
— it doesn't auto-pull, since `op inject` triggers a biometric prompt.

### Troubleshooting

- **`op` not signed in** — see the desktop-integration step above, or
  `op signin`.
- **"vault not accessible"** — ask an admin to add your account to
  `Kodus-Dev`.
- **"unresolved reference"** — the item or `password` field is missing
  in the vault. The error message names the exact `op://...` ref;
  create it, then re-run.
- **The old `.env` had a var the template doesn't have** — it was
  backed up to `.env.bak.YYYYMMDD-HHMMSS`. Diff it; if the missing var
  is legitimate, add it to `.env.schema` (don't reintroduce a drifty
  per-dev override).

## The cascade — which value wins

`.env.local` (personal) beats `.env` (team baseline), in every context:

- **App outside docker:** NestJS' `ConfigModule.forRoot` is wired with
  `envFilePath: ['.env.local', '.env']` (and the same order is used in
  every `dotenv.config()` site across the repo). `.env.local` is loaded
  first, so any key it sets wins; `.env` then fills in everything else.
- **Inside docker:** `docker-compose.dev.yml` declares
  `env_file: [.env, .env.local]` (the latter optional) on every app
  service — compose loads `.env.local` **last**, and last wins. So the
  same override reaches containers too.

If you don't have a `.env.local`, nothing changes — the baseline
applies as-is. Typical `.env.local` content: a webhook tunnel URL
(`API_GITHUB_CODE_MANAGEMENT_WEBHOOK=https://<your-ngrok>/github/webhook`),
a port offset for a second worktree, `LOG_LEVEL=debug`.

One caveat: variables that compose interpolates **inside the YAML
itself** (`${WEB_PORT:-3000}` in `ports:`, etc.) come from the shell /
project `.env`, not from `env_file` — `.env.local` can't override
those.

## Daily workflow

### Adding a new env var

1. Add a `process.env.X` reference where the var is consumed.
2. Add the corresponding entry in `.env.schema`:
   ```env
   # Short description of what this controls.
   # @optional @sensitive
   # kodus: audience=both
   API_NEW_FEATURE_KEY=
   ```
3. Add the value to your local `.env` to test.
4. Run `pnpm run env:apply` — regenerates `.env.example`, `.env.template`,
   and the docs snippet.
5. Commit `.env.schema` + the regenerated files together.

CI blocks the PR if `pnpm run env:check` finds drift between the schema
and the committed outputs, **or** if code references a var the schema
doesn't declare (coverage check).

### Adding a new secret

1. Add the var to `.env.schema` with `@sensitive` and leave the value
   blank (so the generator emits an `op://...` ref).
2. `pnpm run env:apply` — regenerates `.env.template` (and the rest).
3. Create the matching item in the vault — or just re-run
   `./scripts/env/bootstrap-vault.sh` which is idempotent and will
   create the new item alongside the existing ones:
   ```bash
   op item create --vault "Kodus-Dev" --title "MY_NEW_KEY" \
       --category "Password" password="<value>"
   ```
   (We use the `Password` category, not `API Credential`, because the
   latter has a `valid from`/`expires` pair that the 1P UI flags as
   "expired" when left at the default `0` timestamp.)
4. `pnpm run env:pull` to materialize.

**Don't forget to fill the value** — an empty vault item injects an
empty string, which silently breaks `@required` consumers.

### Rotating a secret

Edit the item's `password` field in 1Password (UI or
`op item edit "MY_KEY" --vault "Kodus-Dev" password="<new>"`). Each
dev runs `pnpm run env:pull` to pick up the new value.

### Renaming or removing a var

Same flow as adding — edit the schema, run `pnpm run env:apply`, commit.
The dead var disappears from all generated outputs automatically.

### Different default for self-hosted

Add `installer-default="..."` on the `kodus:` line. The cloud
template keeps the original; the installer gets the override.

### Multi-line secrets (PEM keys, certs, etc.)

**Store them single-line with `\n` escapes** — never as a raw
multi-line value. `docker compose` reads `.env` via `env_file:` and its
parser does **not** support multi-line values: a raw PEM injects as a
value spanning several physical lines, leaves a dangling quote, and
makes the whole stack fail to boot with a cryptic "unexpected character
in variable name" error on some unrelated later line.

`pnpm run env:pull` guards against this — it refuses to write a `.env`
whose values contain raw newlines and tells you which item is at fault.
To store a PEM correctly:

```bash
# collapse a PEM into one line with literal \n, then store it
awk 'NR>1{printf "\\n"} {printf "%s", $0}' key.pem | \
    op item edit "API_GITHUB_PRIVATE_KEY" --vault "Kodus-Dev" "password=-"
```

The app un-escapes `\n` at read time (see
`libs/platform/.../github/github.service.ts`), so consumers get a real
multi-line key. If you have no real dev key, leave the item **empty** —
it injects cleanly and the app guards on the missing value.

## Schema syntax

Each var entry has a description, varlock decorators, Kodus metadata,
and `name=default`:

```env
# What the var does and why it matters.
# @required @sensitive @type=url
# kodus: audience=both installer-default="kodus_db"
API_PG_DB_DATABASE=kodus_db
```

### Standard varlock decorators

- `@required` / `@optional`
- `@sensitive` (treat as secret in tooling)
- `@type=<port|url|email|number|boolean|cron|enum(a,b,c)>`

### Kodus metadata (custom)

- `kodus: audience=<value[,value]>` — `cloud`, `self-hosted`, `both`,
  `self-hosted-enterprise`. Combinations allowed (e.g.
  `cloud,self-hosted-enterprise`).
- `kodus: installer-default="<value>"` — different default for the
  installer template (e.g. `kodus-api` vs `kodus_api` containers).
- `kodus: installer-comment=true` — the var appears commented-out in
  the installer template (opt-in feature).

### Audience semantics

| audience | kodus-ai/.env.example | installer/.env.example | docs badge |
| --- | --- | --- | --- |
| `cloud` | ✅ | ❌ | ☁️ Cloud |
| `self-hosted` | ❌ | ✅ active | 🏠 Self-hosted |
| `both` | ✅ | ✅ active | ⚙️ Both |
| `both` + `installer-comment=true` | ✅ | ⚠️ commented | ⚙️ Both (opt-in) |
| `self-hosted-enterprise` (alone) | ❌ | ❌ | 🏢 Self-hosted Enterprise |
| combinations (e.g. `cloud,self-hosted-enterprise`) | per audience | per audience | 🏢 + scope badge |

## Commands

| Command | Description |
| --- | --- |
| `pnpm run env:pull` | Materialize `.env` from `.env.template` via 1Password (`op inject`) |
| `pnpm run env:pull:check` | Verify 1Password CLI is signed in and the vault is reachable |
| `pnpm run env:apply` | Apply: writes real `.env.example`, `.env.template`, and `docs/_snippets/...` |
| `pnpm run env:generate` | Preview into `.env-preview/` (no overwrites) |
| `pnpm run env:check` | Drift check + coverage check (used by CI gate) |
| `pnpm run env:doctor` | Flag missing required values in your local `.env` |
| `pnpm run env:audit` | Build review CSV at `.env-preview/review.csv` |

`pnpm run env:apply` does NOT touch `kodus-installer/.env.example` — that
is cross-repo and only regenerated by CI on release tag.

## Vault convention

One **Item per env var**, named **exactly** as the var, value stored in
the **`password`** field. So `API_OPEN_AI_API_KEY` looks like:

| Item field | Value                              |
| ---------- | ---------------------------------- |
| title      | `API_OPEN_AI_API_KEY`              |
| password   | `sk-...`                           |

The template references it as:

```env
API_OPEN_AI_API_KEY="op://Kodus-Dev/API_OPEN_AI_API_KEY/password"
```

To list every item the vault needs right now:

```bash
grep -oE 'op://[^"]+' .env.template | sort -u
```

Sensitive vars that already have an inline default in the schema
(local-docker fixtures like `API_PG_DB_PASSWORD=123456`,
`RABBITMQ_DEFAULT_PASS=devpass`) stay **literal** in the template — they
aren't real secrets and putting them in 1Password adds friction for
zero gain.

## CI integration

### `env-drift-check.yml`

Runs on every PR that touches `.env.schema`, `.env.example`, or
`scripts/env/**`. Two gates:

1. **Drift** — fails if `pnpm run env:apply` produces different generated
   files than what the PR committed.
2. **Coverage** — fails if code references a Kodus-shaped env var that
   the schema doesn't declare (with an allowlist for CLI-only vars,
   test fixtures, and false positives in
   `scripts/env/check-coverage.ts`).

Required check on `main` once the workflow is registered.

### `env-sync-release.yml`

Runs on release tag (`v*`). Regenerates `kodus-installer/.env.example`
from the current schema and opens a PR in `kodustech/kodus-installer`
if there's drift.

Requires `CROSS_REPO_PAT` secret (PAT with `repo` scope on
`kodustech/kodus-installer`).

## How the installer template stays in sync

The installer is the only output that lives outside this monorepo, so
it has its own sync flow:

```
kodus-ai release tag (v2.x.y) pushed
  └─ env-sync-release.yml triggers
       ├─ checks out kodus-installer
       ├─ runs `pnpm run ts-node scripts/env/generate.ts --apply --installer
       │                       --installer-out=../kodus-installer/.env.example`
       ├─ if .env.example changed → opens PR in kodus-installer
       └─ maintainer approves PR (matches release tag)
```

A maintainer of `kodus-installer` reviews the auto-generated PR before
merging — it's never auto-merged, so a human sanity-checks each
release.

## Files

```
.env.schema                              ← THE source
.env.template                            ← 1Password injection template (committed)
.env.example                             ← OSS-friendly template (committed)
scripts/env/
├── parse-schema.ts                      ← reads & validates the schema
├── generate.ts                          ← renders the 4 outputs
├── pull.sh                              ← pnpm run env:pull — op inject → .env
├── bootstrap-vault.sh                   ← creates vault items from the template (idempotent)
├── check-drift.ts                       ← CI gate, drift half (pnpm run env:check)
├── check-coverage.ts                    ← CI gate, coverage half (pnpm run env:check)
├── build-slim-csv.ts                    ← review CSV builder (pnpm run env:audit)
├── open-sync-pr.sh                      ← helper used by the cross-repo workflow
└── README.md                            ← this file
.github/workflows/
├── env-drift-check.yml                  ← PR gate
└── env-sync-release.yml                 ← cross-repo installer sync
```

## Why "varlock-style" decorators if we parse them ourselves?

The schema syntax (`@required`, `@type=...`, etc) follows the
[varlock](https://varlock.dev) spec. Our generators parse it ourselves
(`scripts/env/parse-schema.ts`) — the varlock library itself is **not**
a runtime dependency. We just adopted their decorator syntax because
it's readable and well-documented.

If we ever want schema-validated runtime injection
(`varlock run -- pnpm run start`), the lib can be re-added — the same
schema works without changes.
