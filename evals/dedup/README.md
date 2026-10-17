# dedup (research data, #1821)

> - **Answers:** Nothing on its own: this folder holds the hand-labelled dedup gold (`gold-v2/`) and the TP gold of the 50 PRs (`gold-v3/`), with the scripts that built and scored them.
> - **Runs:** never on a schedule. The dedup eval that runs is `evals/funnel/dedup/run.js`, and the grouping eval reads this gold through its own `build-cases.js`.
> - **Run it:** `evals/dedup/gold-v2/fluxo-producao.sh <prefixo> <gold model> <RECALL_MODEL> [prs]` replays the post-finder flow on a pool; `python3 evals/dedup/gold-v2/placar-v3.py <model> --prefixo=<p>` scores it on gold v3.
> - **Gate:** none. Research numbers, not a CI floor.
> - **Cost:** one dedup, verify and nit call per PR when the flow is replayed; scoring reads files only.

The scripts here predate the funnel evals and call the old harness
(`dedup-runner.js`, `../investigation/eval-model.js`), which the main branch
removed. They stay on this branch so the gold can be rebuilt and re-scored.

- `gold-v2/`: the dedup grouping gold, the production-flow replay (`fluxo-producao.sh`) and its verify and nit steps.
- `gold-v3/`: the TP gold (`golden.json`), the known FPs (`fps-conhecidos.json`), the suggestion-to-TP map (`sugestoes.json`), how they were assembled (`montar.py`) and the upstream check of every TP (`verificacao-upstream.json`).
