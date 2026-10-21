# Business-logic requirements eval

> - **Answers:** Of the requirements a PR does, how many does the business-logic stage call a gap, and of the ones it leaves out, how many does it catch?
> - **Runs:** on demand and weekly on every tier-0 model (`evals/weekly.js`); every engine PR against the scripted model (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/business-logic-requirements/run.js [--model=<tier-0 id>] [--gate] [--verify]`
> - **Gate:** `--gate` uses two per-model floors in `targets.json`: `floor` for done work not called a gap, `gapsFloor` for gaps caught. A judge call that fails (a key, a quota, a timeout) is not measured (exit 2), never a miss.
> - **Cost:** per case, the judge call, its second look at each MISSING, PARTIAL or CHECK MANUALLY requirement, and the verify call with `--verify`; 29 cases.

It runs production's `BusinessLogicValidationStage` through the harness in
`evals/business-logic/production-stage.js` (what is production's and what is
the eval's data is listed there), and reads the verdict the stage hands
`BusinessLogicPublisher.publish`. Each requirement of the gold is found in the
verdict by its pattern and is right when its state is one the gold accepts.

Two numbers, because one hides the other:

- **done work not called a gap** (the metric): of the requirements the PR does,
  the share whose state is not `missing` or `partial`. A false gap tells an
  author to redo done work (#1725, #1884, #2019). A requirement the ticket
  never stated and the verdict calls a gap counts as one (`onlyGold` cases).
- **gaps caught**: of the requirements the PR leaves out, the share called
  `missing` or `partial`.

A requirement whose gold is neither (to check by hand, or either state) is
scored right or wrong in its case but counts in neither number.

## Cases

`cases.json` and `files/`, written by `build-cases.py` (edit the cases there and run it), from three axes the known false gaps came from:
where the code that does the requirement is (in the diff, under another name,
in a file the PR does not touch, a look-alike, half of it, nowhere), what kind
of requirement it is (a rule, a validation and its message, an API or stored
field, copy, a test or a log, another sub-task's work), and how the ticket is
written (a criteria list, prose, Portuguese, a sub-task with its parent, a thin
ticket). Every case that does all of a requirement has a twin that leaves it
out (`<id>-…`, "control for"), so a stage that calls everything done, or
everything a gap, fails one of the two numbers. The domains are invented.
