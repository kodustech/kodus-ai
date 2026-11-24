# libs/runtime/protocol

The single source of the hub↔cell protocol (docs §1b, ADR-051) and of the recipe (`.kodus/workspace.yaml`): zod schemas from which the JSON Schema and the Go cell's types and constants are generated. The hub decodes every cell frame with it (`apps/runtime/src/hub/cell-hub.ts`); the worker, the API and the blocker catalog read its recipe and sandbox schemas. See [`libs/runtime/README.md`](../README.md) "protocol".

## Owns
- Decoding: `strict-json.ts` `parseStrictJson` (no duplicate keys, depth 32, no trailing data, no `__proto__`: `JSON.parse` builds the value and one scan of keys and brackets clears it; a frame the scan does not clear goes through `strictJsonByHand`, the reference parser, for the precise error), then `envelope.ts` `decodeFrame` (1 MiB, envelope, `SUPPORTED_VERSIONS` except for a `hello`, the body schema of its type; each refusal a code the hub sends back as a nack).
- The version skew policy: `envelope.ts` `MIN_CELL_PROTOCOL_VERSION`, `HUB_CELL_PROTOCOLS` (also the hello ack's `cellProtocols`, sent only to a cell that names the feature, which `cell update` checks a release against), `helloVersionRefusal` (a cell no newer than the hub and at most one protocol older; `cell_too_new`, `cell_too_old` in `HELLO_VERSION_REFUSALS`), `cellProtocolOf`. The rule: [cell-distribution.md](../../../docs/runtime/cell-distribution.md) "Keeping hub, worker, API and cell compatible". `protocolJsonSchemas` feeds the dump.
- Message bodies: `messages.ts` (claim, step, probe, exec, sandbox, preview, egress, heartbeat, hello; tool layers: `sandbox.acquire` `toolLayers` and `layerBuild`, `claim.ready` `toolLayers`, `toollayer.built`, `toollayer.failed`, hello `capabilities.sandboxImageDigest`; the org purge: `org.purge`, `org.purged`), the hello features `CELL_FEATURES`, `HUB_ACCEPTED_FEATURES`, and `evidenceRequestFor`, which trims what the hub asks to what the cell named.
- The recipe: `recipe.ts` `RecipeSchema`, `parseRecipe` (schema then `recipeRules`), `recipeJsonSchema` (checked in as `recipe.schema.json`); the `suite:` block (e2e-suites.md section 3: `RecipeSuiteSchema`, `suiteRules`, `SUITE_LIMITS`, held to the cell's `internal/recipe/suite.go` by the recipe fixtures); `recipe-features.ts` `requiredRecipeFeatures`; `recipe-fakes.ts`; `recipe-control-env.json`, the env names and prefixes that change what runs rather than how the app is configured.
- The tool layer key: `tool-layer-key.ts` `computeToolLayerKey`, the same bytes the cell's `ComputeKey` hashes; `tool-layer-key-cases.json` is the shared fixture, byte-identical to `apps/runtime-cell/internal/drivers/dockergvisor/toollayer/tool-layer-key-cases.json`.
- Sandbox operations: `sandbox.ts` (one shape from the worker to the guest agent).
- Egress lists: `egress-catalog.ts` over `egress-lists.json` (deny patterns, the recommended list, mirror build args).
- Untrusted YAML: `yaml-limits.ts` `UNTRUSTED_YAML`.
- Shared fixtures: `fixtures/*.json` (frames, `recipes/`, `workspace/`), each with its expected outcome.

## Does not own
- Probe schemas: `libs/runtime/probe` (they are part of the wire; change them the same way).
- What the hub does with a frame: `apps/runtime/src/hub`. The Go decoder and generated types: `apps/runtime-cell/internal/protocol`.

## Rules and limits
- A change flows one way, TS first ([`AGENTS.md`](../AGENTS.md) "Protocol changes", [`apps/runtime-cell/AGENTS.md`](../../../apps/runtime-cell/AGENTS.md) "Protocol"): change the zod schema here; run `scripts/dump-json-schema.ts` (writes `schema/protocol.schema.json` and `constants_gen.go`); `go generate ./internal/protocol/` in the cell; add a fixture for each new acceptance and refusal; both suites pass.
- Every object is strict, so TS and Go read a frame the same way. Patterns compile in RE2 (no lookaround). A `.refine` does not reach the JSON Schema: mirror it in the Go codec with the same code, and cover it with a fixture.
- A constant the cell needs comes from `scripts/go-constants.ts`, never a literal copied into Go.
- `egress-lists.json` is byte-identical to `apps/runtime-cell/internal/netguard/egress-lists.json`, and `recipe-control-env.json` to `apps/runtime-cell/internal/recipe/recipe-control-env.json`; change both copies in one PR.
- `cli-install-commands.json` is byte-identical to `apps/runtime-cell/internal/drivers/dockergvisor/toollayer/cli-install-commands.json`; both validators (`checkCliInstallCommand`, the cell's `CheckInstall`) answer it the same way.
- Every YAML load of repository or model text uses `UNTRUSTED_YAML`.
- The `hello` envelope and body, and the `nack` body, are how two protocol versions meet: never change them in a way an older peer's strict decoder refuses. Raising `PROTOCOL_VERSION` keeps `MIN_CELL_PROTOCOL_VERSION` at the old version only while the hub still sends that version's bodies to a session that chose it.

## Where new code goes
- A field or message between the hub and the cell: `messages.ts`, a hello feature in `CELL_FEATURES` when an older peer may lack it, a fixture, the regenerated Go files.
- A recipe field: `RecipeSchema` (or `recipeRules` for what a schema cannot say), the regenerated `recipe.schema.json`, a fixture in `fixtures/recipes`, and the Go copy in `apps/runtime-cell/internal/recipe`.

## Tests
- `node node_modules/jest/bin/jest.js --runInBand libs/runtime/protocol` (pure; `generated-go.spec.ts` fails when a generated file is stale), then `go test ./internal/protocol/ ./internal/recipe/` in `apps/runtime-cell`.

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (11, tests apart): `egress-catalog.ts`, `envelope.ts`, `index.ts`, `messages.ts`, `recipe-fakes.ts`, `recipe-features.ts`, `recipe.ts`, `sandbox.ts`, `strict-json.ts`, `tool-layer-key.ts`, `yaml-limits.ts`

Imports these Runtime modules:

- [`libs/runtime/contracts`](../contracts/AGENTS.md)
- [`libs/runtime/probe`](../probe/AGENTS.md)

Imported by:

- [`apps/runtime/src/fake-cell`](../../../apps/runtime/src/fake-cell/AGENTS.md)
- [`apps/runtime/src/hub`](../../../apps/runtime/src/hub/AGENTS.md)
- [`apps/runtime/src/hub/claims`](../../../apps/runtime/src/hub/claims/AGENTS.md)
- [`apps/runtime/src/hub/gateway`](../../../apps/runtime/src/hub/gateway/AGENTS.md)
- [`apps/runtime/src/hub/http`](../../../apps/runtime/src/hub/http/AGENTS.md)
- [`apps/runtime/src/shared`](../../../apps/runtime/src/shared/AGENTS.md)
- [`apps/runtime/src/shared/persistence`](../../../apps/runtime/src/shared/persistence/AGENTS.md)
- [`apps/runtime/src/worker/agent`](../../../apps/runtime/src/worker/agent/AGENTS.md)
- [`apps/runtime/src/worker/commands`](../../../apps/runtime/src/worker/commands/AGENTS.md)
- [`apps/runtime/src/worker/dbos`](../../../apps/runtime/src/worker/dbos/AGENTS.md)
- [`apps/runtime/src/worker/env`](../../../apps/runtime/src/worker/env/AGENTS.md)
- [`apps/runtime/src/worker/env-session`](../../../apps/runtime/src/worker/env-session/AGENTS.md)
- [`apps/runtime/src/worker/preview`](../../../apps/runtime/src/worker/preview/AGENTS.md)
- [`apps/runtime/src/worker/run`](../../../apps/runtime/src/worker/run/AGENTS.md)
- [`apps/runtime/src/worker/sandbox`](../../../apps/runtime/src/worker/sandbox/AGENTS.md)
- [`apps/runtime/src/worker/setup`](../../../apps/runtime/src/worker/setup/AGENTS.md)
- [`libs/runtime/api/application`](../api/application/AGENTS.md)
- [`libs/runtime/api/application/recipe-author`](../api/application/recipe-author/AGENTS.md)
- [`libs/runtime/api/application/use-cases`](../api/application/use-cases/AGENTS.md)
- [`libs/runtime/api/domain`](../api/domain/AGENTS.md)
- [`libs/runtime/api/infrastructure`](../api/infrastructure/AGENTS.md)
- [`libs/runtime/api/infrastructure/a2a`](../api/infrastructure/a2a/AGENTS.md)
- [`libs/runtime/blockers`](../blockers/AGENTS.md)
- [`libs/runtime/blockers/rules`](../blockers/rules/AGENTS.md)
- [`libs/runtime/contracts`](../contracts/AGENTS.md)
- [`libs/runtime/environment`](../environment/AGENTS.md)
- [`libs/runtime/protocol/scripts`](scripts/AGENTS.md)
- [`libs/runtime/run`](../run/AGENTS.md)

<!-- module-map:end -->
