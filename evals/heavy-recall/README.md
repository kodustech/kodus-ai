# heavy-recall

> - **Answers:** Of the known bugs in a PR, how many does a heavy review ship, and how many of the comments it ships are known bugs?
> - **Runs:** weekly on every tier-0 model on the controlled set (`evals/weekly.js`), and on demand; never nightly: every case is a full heavy review, the generalist and the nine lenses.
> - **Run it:** `node evals/heavy-recall/run.js --model=<tier-0 id> [--set=controlled|light] [--gate]`
> - **Gate:** `--gate` fails below the floor in `evals/heavy-recall/targets.json`, per set and model.
> - **Cost:** one heavy review per PR (1.3 to 2.1 times the tokens of a normal review on the 2026-11-02 runs) plus the judge; none under the scripted model.

A heavy review is what `@kody review --heavy` and `kodus review --heavy` run: the generalist (with the synthesis rescue where the model's profile has it) and the M3 lenses in parallel, the same verify on every finding, then parse, anchoring, label, repeat drop, dedup, severity, enrichment and the formatter.

The eval is the finder eval on that review: `run.js` runs `evals/investigation/run-recall.js`, which drives production's `AgentReviewStage` over the PR at its head with production's sandbox and model route, with `RECALL_HEAVY=1` and this folder's floors (`--targets`). The cases are the finder's sets (`evals/investigation/recall-tests.js`): `controlled`, 15 PRs, three per repository; `light`, the 30. A case counts the known bugs in its dataset that a shipped comment matches (`recall-assertion.js`, the finder's judge); the result also says how many shipped comments match none (precision), which the experiment reads as `finder-precision`.

What a green number does not prove: the lenses add comments the dataset does not list. A real bug outside the dataset counts against precision, as in the finder eval.
