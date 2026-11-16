# libs/runtime — rules for changing it

Read [README.md](./README.md) first for what each sub-library owns. The root `AGENTS.md` still applies (issues, PRs, eval evidence for the review pipeline).

Each module (a directory with source files) has its own `AGENTS.md`: what it owns, what it does not, its rules, where new code goes, and a generated map of what it imports and what imports it ([module-docs.md](../../docs/runtime/module-docs.md)). The system map, with where new code goes across the Runtime, is [architecture.md](../../docs/runtime/architecture.md). After adding, moving or re-importing a module, run `node scripts/runtime/module-docs.mjs --write`.

## Dependency direction

- `contracts`, `gate`, `probe`, `entry-points`, `redaction`, `api/domain` and the schemas and state of `run`/`protocol` are pure. They may import zod, `crypto` and each other. They may not import Nest, Mongo, TypeORM, `pg`, `fs` or anything under `infrastructure/` or `adapters/`.
- Infrastructure goes in `run/adapters/` and `api/infrastructure/`. Test doubles go in `run/testing/`, `environment/testing.ts`, `contracts/testing.ts`, `api/testing.ts`, `api/__tests__/fixtures.ts` and `libs/runtime-publish/testing.ts`, never in a domain or adapter file. No barrel re-exports them, and no production file imports a testing path (`testing-boundary.spec.ts` in `apps/runtime/src/shared` checks both).
- The process environment is read only in a config loader (`apps/runtime/src/shared/config.ts`, `api/infrastructure/runtime-api.config.ts`, `api/infrastructure/runtime-cron-schedules.ts`) or a boot entry point; domain, adapter and cron code takes typed values. Integers go through `contracts/env-int.ts`, and a limit both sides share has one default in `contracts/limits.ts`. `apps/runtime/src/shared/config-boundary.spec.ts` lists the allowed readers.
- Ports live in `api/domain/ports.ts` and errors that cross layers live there too. An adapter never imports from `application/`.
- `apps/runtime` must not need `@libs/runtime/api/application` or `api/infrastructure` in production code. A rule both sides share goes to `contracts/`.
- Inside the folder, import by file path (`@libs/runtime/contracts/enums`, `@libs/runtime/run/sealed-secret`), not through a barrel, to avoid cycles.

## The gate fails closed

- `gate/gate.ts` returns `inconclusive` for every case it cannot decide: bad input, a varying decisive field, health failures that do not prove the PR, and an `expected` that disagrees. A new branch never turns an unknown case into `not_reproduced` or `pre_existing`.
- Every change to `decideProbe`, `decideRunVerdict` or `checkConclusionFor` comes with a test of the new case in `gate/gate.spec.ts` or `run/run.spec.ts`. A halted Run never maps to `success`.
- Coverage comes from the observer's request log on both sides (`entry-points/coverage.ts`), never from an agent label. Code the extractor cannot map stays `unmapped`, and an unmapped entry point is never settled.
- A cut diff (`diffTruncated` and the `.kodus-runtime/diff-truncated` marker) keeps a Run at partly tested. Never drop files silently.

## Facts and state

- **Facts come from the Git API, never the webhook payload.** Read the head, PR state, draft, labels, author, diff, permission and membership through `RuntimeGitPort`. Fields of `RuntimePullRequestObserved` other than the event's identity (org, repo, PR, event, commenter, commentId) feed logs only. An unknown answer from the platform denies.
- **The API never writes Runtime state.** Inject a `RunProjectionReader`, never a store with `upsert`. Runtime Postgres is read only with `RUNTIME_DATABASE_READ_URL` inside `BEGIN READ ONLY`. A decision that changes Runtime state is a command in `contracts/runtime-commands.ts` on the outbox.
- **Every port and query is org-scoped.** New `get`/`list`/write methods take `organizationId` and filter on it in the query, not only in the caller. Another org's object answers 404.
- Push filters such as repository scope, environment and time window into the query. Never cut "the latest N" and filter afterwards.
- A query on a new field needs a typed column, an index (a new version in `apps/runtime/src/shared/persistence/runtime-schema.ts`, see v21) and a limit.

## Tokens and secrets

- `repoToken` and `runToken` travel sealed only (`run/sealed-secret.ts`, through `api/application/secret-sealer.ts`). A Run token is bound to its runId; a setup token is bound to the command `key`.
- Without `RUNTIME_SECRET_SEAL_KEY` nothing that carries a token is enqueued. The schemas refuse plain tokens; do not relax that.
- Never log a token, a prompt, a platform error message or a probe body. Log ids, kinds and counts.
- Metric attributes are bounded. A value the app under test chooses (a host, a path) goes in logs or spans, not in a metric attribute.

## Protocol changes

1. Change the zod schema in `protocol/` (or `probe/`) first.
2. Regenerate: `node -r ts-node/register/transpile-only -r tsconfig-paths/register libs/runtime/protocol/scripts/dump-json-schema.ts`, then `cd apps/runtime-cell && go generate ./internal/protocol/`. A constant, pattern or name list the cell also needs goes in `protocol/scripts/go-constants.ts`, read from its TypeScript export, so the cell uses the generated `constants_gen.go` instead of a hand copy.
3. Add a shared fixture in `protocol/fixtures/` for each new acceptance and each new refusal. Run `npx jest libs/runtime/protocol` and `go test ./internal/protocol/`; both must pass.
4. Patterns must compile in RE2: no lookahead or lookbehind. A rule written as `.refine`/`.superRefine` does not reach the JSON Schema. Mirror it in the Go decoder and cover it with a shared fixture.
5. Keep `redaction/gitleaks-rules.json` byte-identical to the Go copy. Change both in the same PR.

## Renames and stable paths

- A renamed export outside the folder keeps the old name as a `/** @deprecated use X. */` alias until every caller has moved. List the aliases in the PR.
- The import paths in README "Who imports what" must keep resolving. When a file moves, leave a re-export at the old path.

## Naming

- Name a function by what it decides or returns: `decideRunVerdict`, `checkConclusionFor`, `routeShapeOf`, `isBuildIdentityField`.
- A boolean reads as a question (`isKodusOncall`, `decidesVerdict`).
- A port is named for its role and side: `…Reader` for read-only, `…Store` when it writes, `…Port` for an external system. Its token is `RUNTIME_<NAME>` and names the same thing.
- Shared vocabulary (sides, verdicts, blocker kinds, expose kinds, triggers, conclusions) is added to `contracts/enums.ts` and derived elsewhere, never redeclared.
- Comments state the rule and its ADR or S-number, not the history of the change.

## Known gaps

A new command goes on the control queue unless it is work like a Run or a setup (`runtimeCommandRoute`); a cancel stays on the Run queue so it never passes the request it cancels.
