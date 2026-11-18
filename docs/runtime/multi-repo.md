# Environments of several repositories

What is built, as of 2026-11-11. An environment is the system a pull request runs in: one
`primary` repository that holds the recipe, and up to nine `member` repositories booted beside it. An environment
of one repository behaves and reads as before: every new message field is optional and sent only when there is
more than one repository.

## Membership

- Table `runtime_environment_repositories`: environment, org, repository id, name, full name, `role`
  (`primary` | `member`), `alias`, `triggers` (default true), `pair_branches` (default false). Unique per
  environment: repository, alias, one primary. Indexed by org and repository for the webhook lookup
  (`libs/core/infrastructure/database/typeorm/migrations/2026111100000000-CreateRuntimeEnvironmentRepositories.ts:20-52`).
  The migration backfills one primary row per existing environment (`:53-64`). Model and store:
  `libs/runtime/api/infrastructure/runtime-product.models.ts:72-79`, `typeorm-runtime-product.stores.ts:161`.
- Limits: an alias matches `^[a-z0-9][a-z0-9._-]{0,62}$` (`libs/runtime/contracts/workspace.ts:14`); at most nine
  needs, ten repositories (`workspace.ts:25-27`).
- Every lookup goes through `RuntimeEnvironmentMembers` (`libs/runtime/api/application/environment-members.service.ts:69-154`).
  An environment with no rows reads as its primary alone (`:85-96`). A repository may be a member of several
  environments; `environmentsOf` lists the one it is the primary of first (`:118-135`).

### Routes

All under `runtime/environments/:id`, in `apps/api/src/controllers/runtime/runtime-environments.controller.ts:158-191`:

| Route | Permission | What it does |
|---|---|---|
| `GET repositories` | Read | Primary first, then members by alias (also in `GET :id`) |
| `POST repositories` | Manage | Adds a connected repository, asks for a setup; 409 on a taken alias, the primary itself, or past ten |
| `PATCH repositories/:repositoryId` | Manage | `alias`, `triggers`, `pairBranches`; a new alias asks for a setup |
| `DELETE repositories/:repositoryId` | Manage | Members only (409 for the primary); asks for a setup without it |

Use cases: `libs/runtime/api/application/use-cases/environment-repositories.use-cases.ts:93-221`. Until the new
setup passes, Runs use the last good one.

### The primary's alias is fixed

The primary's alias is always `repositoryAliasOf(fullName)`: the short name lower-cased, other characters as `-`,
no leading `.`/`_`/`-`, cut to 63, `repo` when nothing is left (`workspace.ts:38-46`). The cell computes the same in
Go (`apps/runtime-cell/internal/recipe/needs.go:94-98`) and the protocol carries no alias for the primary, so:

- reads replace whatever the primary row says with that alias (`environment-members.service.ts:92-94`);
- `PATCH` refuses a new alias for the primary (`environment-repositories.use-cases.ts:158-163`);
- a member may not take the primary's alias (`:198-206`);
- the worker refuses to start a claim whose primary alias differs (`apps/runtime/src/worker/env/hub-environment-runtime.ts:284-292`, `:384`).

## Which commit each repository runs at

Resolved once, at enqueue, by `pinWorkspace` (`libs/runtime/api/application/run-request-builder.service.ts:169-220`),
and stored on the Run target (`runtime_run_targets.workspace`,
`migrations/2026111100000001-AddRuntimeRunTargetWorkspace.ts`). Each entry has a `source`
(`libs/runtime/contracts/enums.ts:196`):

- `pull_request`: the PR's repository, at the PR's base on the base side and its head on the PR side (`:183-186`);
- `paired`: with `pair_branches`, a member's open PR from a branch of the same name; its base and head on the two
  sides (`:199-209`);
- `default_branch`: any other member, at its default-branch head, the same commit on both sides (`:210-217`).

Run again keeps the stored pins for repositories still in the environment (`:187-197`). A setup boots every
repository at its default-branch head (`libs/runtime/api/application/runtime-setup-requester.service.ts:237-276`).
When the PR is in a member, the primary boots at its pinned commit on both sides (`libs/runtime/run/run-workspace.ts:96-100`).

## Tokens

- Run: the PR's repository uses the Run's own two tokens; every other repository gets two `contents:read` tokens,
  one per side, each for that repository only, sealed to the Run (`run-request-builder.service.ts:222-238`). A fork
  approval mints them again, since the first ones expire while it waits (`:240-268`).
- Setup: one token per repository, sealed to the setup (`runtime-setup-requester.service.ts:268-274`).
- The worker opens the token of the claim's side for each repository and refuses a claim with one missing
  (`hub-environment-runtime.ts:376-390`).
- The cell revokes every token it fetched with, and every token it was given and never used
  (`apps/runtime-cell/internal/agent/workspace.go:62-115`). Redaction knows all of them (`internal/agent/redaction.go`).

## Messages and capability

- `RuntimeEnvironmentSetupRequested.workspace` (`libs/runtime/contracts/runtime-commands.ts:166-181`, `:265`) and
  `RuntimeRunRequested.workspace` (`libs/runtime/run/run-messages.ts:103`, `:254`).
- `claim.acquire.repos` (`apps/runtime-cell/internal/protocol/types_gen.go:204`) goes only to a cell that announces
  the `workspace` feature (`internal/protocol/features.go:67`); any other is refused before anything starts
  (`apps/runtime/src/hub/claims/claim.service.ts:490`, `apps/runtime/src/hub/cell-capabilities.ts:78-91`).

## On the cell

- Layout: `claim/ws/<alias>/` for every repository, the primary under its alias too
  (`apps/runtime-cell/internal/agent/checkout/workspace.go:13-43`). `PlanWorkspace` checks each alias is one path
  segment, appears once, is not the primary's, and that no repository appears twice (`:69-76`).
- `ws/` is the sandbox root; the compose project and the default exec directory are `ws/<primary>`
  (`internal/agent/workspace.go:14-19`).
- Path rules: a compose host path may name another repository as `../<alias>` and nothing outside `ws/`; no
  `$` or `~` expansion, no Docker socket, no symlink in any component from the root down
  (`internal/compose/sandbox/sandbox.go:64-72`, `ResolveWithin` at `:674`).
- `services.needs` boots only repositories the claim brought; any other is refused naming its alias
  (`internal/agent/recipe_fakes.go:57-87`). The worker refuses it earlier with `recipe_needs_member`
  (`apps/runtime/src/worker/setup/environment-setup.service.ts:397-399`). Parsers: TS `libs/runtime/protocol/recipe.ts:350-362`,
  Go `internal/recipe/needs.go:56`, `:115`.
- Mirror pins are read from every repository (`internal/agent/prepare.go:256-260`).
- `refsDigest`: sha256 over the sorted `repositoryId:sha` lines plus the recipe digest
  (`libs/runtime/contracts/workspace.ts:67-86`; Go `internal/bakecatalog/refs.go:32-40`). The bake carries it
  (`run-workspace.ts:106`); the cell refuses a bake whose digest and booted repositories disagree
  (`internal/agent/image_policy.go:61`, `:130-134`).

## exec.repository

When the PR is in a member, every command of the Run goes to that member's directory: the worker sets
`execRepository` to the member's alias (`libs/runtime/run/run-workspace.ts:198-199`,
`apps/runtime/src/worker/dbos/run-deps.factory.ts:159-172`) and sends it on each exec
(`hub-environment-runtime.ts:425-428`). The cell accepts only an alias of the claim's repositories, on a cell that
lays workspaces out (`apps/runtime-cell/internal/agent/handle.go:115-140`).

## Access over every member

Reading or acting on an environment or its Runs needs access to every repository of it, since its machines hold
all their code (`environmentRepositoryIds`, `environment-members.service.ts:162-170`):

- Run routes, for users and team keys' `repositoryIds` (`libs/runtime/api/application/run-access.service.ts:46-80`);
- setup, settings, blocker fixes, egress approval, recipe proposal (`request-environment-setup.use-case.ts:35`,
  `update-environment-settings.use-case.ts:104`, `apply-blocker-fix.use-case.ts:87`, `approve-egress.use-case.ts:71`,
  `propose-inferred-recipe.use-case.ts:57`);
- the PR-runs list shows a Run only when the caller reaches every repository of its environment
  (`libs/runtime/api/application/use-cases/pull-request-runs.use-case.ts:85-125`);
- simulate accepts a PR of any member and checks every repository (`simulate.use-case.ts:84-94`).

## Webhook gate and trigger

- A repository's PR events are recorded when it is in any environment, as primary or member; the answer is cached
  30 s (`libs/runtime/api/infrastructure/membership-pull-request.gate.ts:7-36`, wired in
  `libs/runtime-publish/runtime-pull-request-gate.module.ts`).
- A PR starts one Run per environment whose membership of that repository has `triggers`
  (`libs/runtime/api/application/use-cases/pull-request-trigger.use-case.ts:113-155`).

## One live Run per environment

The live-Run index is one live Run per org, repository, PR, head **and environment**
(`runtime_runs_one_live_per_environment_sha`, `apps/runtime/src/shared/persistence/runtime-schema.ts` v21). Run again checks only
Runs of the same environment (`libs/runtime/api/application/use-cases/run-again.use-case.ts:92-98`), so a live Run of
the same PR in another environment no longer blocks it.

## Report and screens

- The comment says "Ran with billing @ a1b2c3d (main)" or "paired with billing #42"
  (`libs/runtime-publish/domain/render-runtime-comment.ts:143-158`).
- Environment page: a Repositories section (`apps/web/src/app/(app)/runtime/environments/[environmentId]/_components/repositories.tsx`).
  Environments list: repositories per row (`.../environments/_components/environments-table.tsx`). Run page: the
  commit of every repository (`apps/web/src/core/components/runtime/run-workspace.tsx`).

## Env sessions and A2A

- **MCP `env_up`:** a multi-repository environment boots whole, like a setup: every repository at its default-branch
  head or at the commit `commits?: Record<alias, sha>` names, each with a download token for that repository only
  (`libs/runtime/api/application/env-tools.service.ts:180-229`). `env_exec` takes `repository?` (`:254-257`).
- **A2A:** a submission takes an optional `environmentId`
  (`libs/runtime/api/application/external-findings.service.ts:145-162`). Named: it must hold the repository and the
  key must cover every member, else 404. None named: the environment the repository is the primary of, else the only
  one reachable, else 409 `environment_required` with the reachable ids (`:99-110`).

## Not done yet

- **A2A `verify_finding` on legacy records:** a finding stored without `environmentId` resolves as if none was named
  (`external-findings.service.ts:429`), so a repository in several environments answers 409.
- **Step rows:** the `env_exec` audit row records the session's repository, not the `repository` the command ran in
  (`env-tools.service.ts:308-316`).

## Plan steps

| # | Step | State |
|---|---|---|
| 1 | Membership table, backfill, lookups through membership | Done |
| 2 | Webhook gate and trigger through membership; Run per environment; access over every member | Done |
| 3 | Typed `services.needs` in TS and Go, contract fixtures, precise blockers | Done |
| 4 | Optional workspace fields in setup, Run and acquire, behind the cell capability | Done |
| 5 | Setup and Run: N heads, pins, 2×N tokens, stored refs, Run again, simulate, A2A | Done; open: legacy `verify_finding` and step rows (above) |
| 6 | Cell: N fetch/revoke, `ws/<alias>`, sandbox root, pins union, redaction, bake digest, `recipe_needs` lifted | Done |
| 7 | Recipe author: composite reader and `../<alias>` path policy (`recipe-author/workspace-repo-reader.ts:8-31`, `authored-files-policy.ts:847`, `:1158`) | Done |
| 8 | Screens and report | Done |

Validation: unit and contract tests exist for every layer. The product checks on a synthetic pair of repositories
(V1 to V8) are not recorded in this document.
