# runtime-planner-quality

> - **Answers:** Does Kody Runtime’s planner probe what each kr-* pull request changes, at the path the app serves, predict what base answers, end in the same right verdict when the same PR runs again, and does the recipe author boot a repository within its token budget?
> - **Runs:** on demand, over Runs the product made (`@kody runtime` on a kr-* test repository). Not in `evals/stages.js` or the wiring smoke: those list code-review steps.
> - **Run it:** `docker exec -i -e SINCE_DAYS=7 kodus_runtime_worker node - < evals/runtime-planner-quality/export.js > traces.json` where the Runtime runs (the worker container: only it has `RUNTIME_EVIDENCE_DIR`, the recorded bodies `--regate` needs), then `node evals/runtime-planner-quality/run.js --traces=traces.json` · `--since=<ISO date>` · `--runs=<id prefix,...>` · `--regate` · `--repeat-rounds` · `--output=<result.json>` · `--json`. Tests: `node --test evals/runtime-planner-quality/score.test.js`.
> - **Gate:** none yet. A floor needs two measured sets of the same commit (rule 9); see "Floors" below.
> - **Cost:** no model call: the planner and the author already ran in the product, and their tokens are in the traces (`plan.usage`, `authors[].usage`). The result records zeros for the eval itself. A rerun for stability costs one product Run (kr-twenty#1: 45.8k input tokens and 510 s).

The method, the failure modes it was built from and the first measured baseline are in
[docs/runtime/planner-eval.md](../../docs/runtime/planner-eval.md).

## What it reads, and why not a replay

`evals/runtime-test-planner` drives production's planner offline on recorded base machines; it needs model keys and
answers "is this planner better than another on a fixed set". This eval answers what that one cannot: what the
planner did in the product on real Runs, against what the base machine really answered, and whether the same pull
request gets the same verdict twice. It scores what ships (rule 6) by reading production's own outputs, never a copy of
its code:

- `export.js` reads, read-only, per Run the DBOS workflow input (the diff, changed files' content, targets), the
  `entry-points`, `agent:plan` / `agent:plan:early` and acquire steps (`dbos.operation_outputs`), and the Run's report
  (`runtime.runtime_runs.report`: each probe's verdict and the status base and the PR answered); per setup each
  `recipe:author` and `recipe:repair:<n>` outcome and the boot that followed. Only `kr-*` repositories; no
  organization or team id. The file it writes stays outside the repository. Run in the worker container
  (`kodus_runtime_worker`, where `RUNTIME_EVIDENCE_DIR` is) instead of the hub, each replay round whose body is not JSON
  also carries that body as the worker's step evidence kept it (redacted, at most 1 MiB) and its content type
  (`bodies: true` in the file).
- `run.js` scores it against `cases.json` and runs production's `extractEntryPoints`
  (`libs/runtime/entry-points/extract.ts`) on each case's recorded diff and content (rule 1).

Rules 2–5 (same input, tools and model route) hold by construction: nothing is re-run here. Rule 7 is
`score.test.js`: a right Run, and the same Run broken one way per check, turns each check red.

## Cases

`cases.json`: one case per kr-* pull request head, labelled by reading its diff. `acts: true` when the diff changes
what the app answers (the Run must report it), `false` for the controls (equivalent changes, comments, dependency or
recipe only). Each case says in one sentence what it checks. Pairs: kr-shop#2 (quantity 0 accepted) against kr-shop#3
(the same rule written differently); kr-directus#1 (trim of a null) against #2 (guarded); kr-shop-billing#2 against #1;
kr-nextjs#2 (page text) against #1 (a comment); kr-grafana#4 against #11.

`excludeRuns` drops Runs whose outcome measured another bug (a member's PR probed against the primary's app before
the fix that boots a member with its environment's setup, or a cell fault). Each is named by `runKey` in `score.js`, a
digest of the Run id's first 8 characters, so the labels do not list Run ids; the export holds the ids. The digest is a
label, not a secret: 32 bits can be reversed by brute force. A Run with no plan (it never booted) or no verdict (it errored) is counted apart, as not measured.

## Checks

Per planned Run, all code (no judge):

- **verdict accepted:** the Run's verdict is in the case's `accept`, and for a case labelled `intended` (the PR means
  the change) a probe reports it as the PR's intended change (a finding with intent `intended`).
- **`--regate`:** each Run's recorded replay rounds (`replay`: the gate fields per side and round, exported per probe)
  decided again by production's `decideIntendedChange` (`libs/runtime/gate/intended-change.ts`), and the Run's verdict
  with it (no unintended finding left: a regression is partly tested, as `decideRunVerdict`). A round that carries its
  recorded body has its fields derived again first (`notJsonBodyFields`: an HTML page's text and markup skeleton) and
  the probe is decided again by `decideProbe`; the recorded outcome stands when the old and new fields decide the same
  verdict. A decision that asks for a round the replay never played is left as recorded and counted; with
  `--repeat-rounds` (an assumption the output names) the side's last round is taken as played again. The line of a Run
  whose verdict moves reads `recorded → regated`. A trace exported before `replay` existed is scored as recorded.
- **relevant probe:** for a case whose diff reaches a route, one probe matches a `reaches` entry (method, a path regex
  with the mount prefix, an optional request media type and a body, or a browser probe).
- **right Run** (the headline): verdict accepted and, where the diff reaches a route, a relevant probe.
- **probe precision:** probes matching `reaches` over all probes, on cases whose diff reaches a route.
- **path under the prefix:** http probes whose path matches the case's `prefix` (the app's API mount), over http probes.
- **expectation:** a probe's `assertions.status` equals the status base answered. A route the PR adds (base 404, PR
  not) is left out: its prediction is the PR's.
- **stability:** per case with two or more planned Runs, the share that ended in the most common verdict and the number
  of distinct plan shapes (method and path per probe, ids folded).
- **route mapping:** changed files that serve a route (`files.<path>.serves`) for which the extractor sees one of
  them (`routesServedBy`: what the file declares, whatever its diff touched; a route that serves any method, `ALL`,
  matches a label of one); **over-mapped:** routes `extractEntryPoints` hands the planner that the diff's lines do not
  reach. Since planner-eval.md fix 1 a comment-only file hands the planner no route at all, so the two are read apart.
- **nothing_to_test:** a Run that ended before boot because every change is a comment, layout or documentation is
  scored with no plan and no model call (its plan shape is `(no probe)`).
- **plan seconds and tokens:** model plans only (a plan made with no model call is counted apart). A plan made while
  the PR boots (`agent:plan:early`) counts from the base's ready, not from the step's start, which first waits for the
  base.
- **recipe author:** per `recipe:author` / `recipe:repair:<n>` call, submitted, booted (the boot after it ready), out of
  its token budget. A call the model route did not answer (`llm_unavailable`) is not measured.

A judge is not used: every check above is decided by a label or by what base answered. One would be needed only to
score probe relevance on pull requests nobody labelled; it would then be validated against these labels first
(`validate-evaluator`), never trusted alone.

## Floors

None yet. One export is one sample of a stochastic planner; a floor needs the same commit measured twice (rule 9),
which for this eval means each stability case rerun at least three times on one deploy, serially, through the product.
Until then the numbers are a baseline to compare a fix against, read per case.
