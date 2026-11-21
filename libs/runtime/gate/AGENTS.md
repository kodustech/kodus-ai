# libs/runtime/gate

The verdict of one probe: a pure function that compares the normalized fields of the observer's steps on the base and the PR and answers `more_rounds` or a verdict (`finding`, `not_reproduced`, `pre_existing`, `inconclusive`, `new_endpoint`, and from the intent oracle `intent_mismatch`, `described_change`). It runs inside the runtime-worker's Run workflow (`apps/runtime/src/worker/run/`), round after round; the Run's verdict is `libs/runtime/run` `decideRunVerdict` over these.

## Owns
- `gate.ts` `decideProbe`: the order of checks (input, image, both sides, health, masking, agreement, expectation, difference), described in [`libs/runtime/README.md`](../README.md) "gate".
- `gate.ts` `decideNewEndpoint`: a route the diff adds is new behavior, not a regression, whatever the PR answers under 500 (its own 404 included).
- `intended-change.ts` `decideIntendedChange`: a difference the diff spells out literally is marked intended.
- `stated-intent.ts` `decideStatedIntent` (docs/runtime/intent-oracle.md): an intent probe's assertions, quoted from the PR's text, read on the PR side's rounds (`intentAnswerOfFields` rebuilds the JSON from the compared fields). A failed one on an intent probe is `intent_mismatch` in place of a comparison that found no failure of its own; all held on a `behavior_change` whose every differing field they read, with no 5xx, is `described_change`. On a planned probe of the same request it only explains. `statedIntentHolds` is an intent probe's `expectedHolds`. `statedIntentChecksFor`: a planned probe gets every assertion of an intent probe of its request, else the rules over response fields (`isRouteInvariant`) of those of its method and route, which only explain.
- `probe-fields.ts`: an observer result as the fields the gate compares (`normalizeFields`, `effectiveCompare`, `expectedHolds`); `html-fields.ts` for an HTML body.
- `stability.ts`: the versioned stability history read as a policy (ADR-050): `NORMALIZER_VERSION` (bump when a compared field's name or normalization changes; older history is then ignored), `stabilityPolicyFor` (history → base rounds, known unstable fields, the `snapshot` every verdict records), `baseUnstableFields` (what a Run writes: base rounds only, never the PR's, S-36), `probeKeyOf` (the probe shape history is kept by). The store is `apps/runtime/src/worker/run/pg-stability-history.ts`.
- `gate.ts` `markUnbackedClaims`: what the agent says it proved stays `unverified` unless a step backs it.
- `kept-check.ts`: a kept check's outcome (docs/runtime/kept-checks.md §5): `keptCheckStaleness` (main's healthy rounds answer 404/405 where it answered otherwise when kept: `route_gone`; fail the kept expectation in every round: `baseline_changed`) and `keptCheckOutcomeOf` (the final verdict after intent as `failed`, `intended`, `passed` or `inconclusive`; stale wins).

## Does not own
- Running probes and resets: the runtime-worker (`apps/runtime/src/worker/run/`) and the cell's observer (`apps/runtime-cell/internal/observer`).
- The Run's verdict, its check conclusion and wording: `libs/runtime/run`, `libs/runtime-publish`.
- Writing the intent probes: `libs/runtime/planner/intent-author.ts`. The assertion set and its parser: `libs/runtime/contracts/probe-assertions.ts`.

## Rules and limits
- Pure: no I/O, no clock, no text read as an instruction. Only fields of steps the observer produced on the pinned image decide.
- Anything it cannot decide is `inconclusive`; nothing unknown becomes `not_reproduced`.
- A decisive field (no dot: `status`, `exit`, `json`…) that varies on the base is never masked away. At most 5 fields masked for the base's variance and its history; past that the probe is `inconclusive`. Fields only the PR carries that vary between its rounds are masked on top of those, and only once a decisive field already differs on every PR round, so a finding's `maskedFields` can list more than 5. When the PR's rounds disagree, a compared field the base agrees on (or one only the PR carries, with the same value on every PR round) that differs from the base on every PR round is a finding, and the fields that vary only between the PR's rounds are masked (v-core N1); without one the probe asks for more rounds, then ends `inconclusive`. 4 rounds per side by default.
- History only makes the gate more careful: `knownUnstableFields` are masked (decisive ones make it `inconclusive`, they count toward the ceiling), and a PR that differs only on one of them gets more base rounds, then `inconclusive`; a probe with unstable history starts with 3 base rounds instead of 2.
- Pixel-only differences never fail a check (`inconclusive` with the visual question).
- A stated intent explains a difference only when every differing field is one a passed assertion reads (an array: an `every` on it with a length on it, or an `every` whose sentence says "only"; `includes` explains nothing) (a status that changed as asserted carries its body; a path through an array index never explains the whole array), on every PR round, with no 5xx; a failed one never turns a 5xx, a lost machine or an error on a new endpoint into a mismatch.
- An intended change needs an explanation specific to what the probe read: the status, JSON numbers, booleans and null, and literals under 4 characters or without a letter are never explained; a one-word JSON value must be a whole string literal on a changed row that names its key in key position (`role: "x"`, `"role": "x"`, `role = "x"`), never inside another string; comments (rows, block comments and Python docstrings, followed through the hunk and from the file's content when it came, and the part of a row after its comment opens), test files and project documents explain nothing; and only the file the covered route is declared in explains (`reachableFiles`: never the agent's `via`, a file no route reaches, a doc or a `.txt`) (`intended-change.ts`, v-core N2).

## Where new code goes
- A new kind of compared field: `probe-fields.ts` (its normalization) and the masking rules in `gate.ts`, with a case in `gate.spec.ts`.
- A new verdict or finding kind: `libs/runtime/contracts/enums` first, then the gate, then the publisher's wording and the web's labels.

## Tests
- `node node_modules/jest/bin/jest.js --runInBand libs/runtime/gate` (pure, no services).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (8, tests apart): `gate.ts`, `html-fields.ts`, `index.ts`, `intended-change.ts`, `kept-check.ts`, `probe-fields.ts`, `stability.ts`, `stated-intent.ts`

Imports these Runtime modules:

- [`libs/runtime/contracts`](../contracts/AGENTS.md)
- [`libs/runtime/entry-points`](../entry-points/AGENTS.md)
- [`libs/runtime/probe`](../probe/AGENTS.md)
- [`libs/runtime/redaction`](../redaction/AGENTS.md)

Imported by:

- [`apps/runtime/src/shared/persistence`](../../../apps/runtime/src/shared/persistence/AGENTS.md)
- [`apps/runtime/src/worker/agent`](../../../apps/runtime/src/worker/agent/AGENTS.md)
- [`apps/runtime/src/worker/run`](../../../apps/runtime/src/worker/run/AGENTS.md)
- [`apps/runtime/src/worker/setup`](../../../apps/runtime/src/worker/setup/AGENTS.md)
- [`libs/runtime/api/application/use-cases`](../api/application/use-cases/AGENTS.md)
- [`libs/runtime/contracts`](../contracts/AGENTS.md)

<!-- module-map:end -->
