# reference-detection

> - **Answers:** Does the reference detector name every file a Kody Rule cites, and nothing else, with an answer reliable enough to cache?
> - **Runs:** by hand (`--repeat=10` on `deepseek-v4.1-flash@together`) when the detector or its parser changes; on every PR in `evals/wiring-smoke.js` against the scripted model. Not nightly, not weekly.
> - **Run it:** `node evals/reference-detection/run.js --model=deepseek-v4.1-flash@together --repeat=10`
> - **Gate:** none: no floor in `targets.json`; the run reports.
> - **Cost:** one model call per case and repeat (4 cases, 40 calls at `--repeat=10`).

Drives production's `ReferenceDetectorService.detectReferencesWithStatus` with a rule's
text, in rule mode, on the slot production's permission service routes when a Kody Rule
is saved (`resolveTaskSlot(codeReview)`, `create-or-update.use-case.ts`). It stops at
detection: resolving the files against the repository is not a model step.

A case is right when the answer is reliable (an unreliable one is not cached and the
call repeats on the next save), names every file the rule cites, and names no other.

Cases (`cases.json`): a rule citing one file and a rule citing none (the controls), and
two rules that quote `</think>` (#2409). Together ends DeepSeek V4.1 Flash's reasoning
channel at a `</think>` the model writes and returns the rest of the reasoning ahead of
the answer; the parser read the first envelope it found, so a reply whose answer sat
whole at the end came back unreliable, and the prompt's own example
(`file-name.ext`), when the reasoning quoted it, was taken for a reference. It
reproduces on some calls only, so the cases are read over ten.

2026-11-06, `--repeat=10` on `deepseek-v4.1-flash@together`: main 126/130 checks, the
centred `</think>` rule fully right in 8 of 10 runs (one missed a file, one came back
unreliable); with the last-object parser, 130/130, every case 10 of 10.
