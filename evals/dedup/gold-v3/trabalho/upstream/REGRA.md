# Was a golden-set bug real? Trace it in the original repository

A benchmark pull request (PR) lives in a local clone (`cloneLocal`, with `base` and `head` SHAs). The golden set lists true-positive bugs (TPs) that this PR introduces. Each TP has an `issueId`, a description (`bug`) and the file:line evidence two reviewers gave (`evidenciaOpus`, `evidenciaAstra`).

Your job: for each TP, find out what happened to that bug in the ORIGINAL open-source repository on GitHub (`upstream`), after the original PR was merged. We are NOT judging the quality of any fix, nor whether it matches a suggested fix. We only ask whether the buggy behaviour was changed.

## Step 1: find the original PR and its merge date (the reference date)

The benchmark PR copies a real upstream PR. Its head commit is often not on the upstream default branch, because upstream squash-merged it. Find the real upstream PR: search by title, branch name, commit messages and changed files, e.g. `gh search prs --repo <upstream> "<title words>"`, `gh pr list --repo <upstream> --state all --search "<words>"`, `gh api repos/<upstream>/commits?path=<file>&until=...`. Record its number, URL and `mergedAt`. The merge date is the reference date for every TP. If the PR was never merged, or merged code differs from the benchmark head, say so.

## Step 2: for each TP, decide one status

Read the code on the upstream default branch TODAY (`gh api repos/<upstream>/contents/<path>?ref=<branch>`, raw file) and the history of the file after the merge date (`gh api "repos/<upstream>/commits?path=<path>&since=<mergedAt>"`, then the commit or PR diffs).

- `confirmado`: a later upstream change fixed the buggy behaviour (any way of fixing counts). Give the fixing PR (or commit), its URL and date.
- `pendente`: the buggy code is still there today, unchanged in the way that matters.
- `descontinuado`: the code that carried the bug no longer exists: the file was deleted, the method was removed, or the logic was rewritten so that this behaviour is gone, without a change that targets the bug. Give the change that removed it and its date when you can.
- `nao_entrou_no_original`: the bug never reached the upstream default branch: the original PR was not merged, or what was merged does not contain the buggy code (fixed during review, or different from the benchmark head).
- `nao_verificado`: you could not decide. Say exactly why.

Lines move as files grow. Match by the code itself (function, condition, call), not by line number. When you are unsure whether a change fixed the bug, whether it is still the same code, or which status applies, consult Astra (below) and discuss with it, at most 5 exchanges per TP, then decide. Record the exchanges briefly.

## Astra (a second reviewer)

Astra has no network access. Give it everything it needs in the prompt: the bug, the code at the benchmark head, the upstream code before and after the candidate change (or today), and your question. Call it with:

    codex exec --skip-git-repo-check --sandbox read-only -m gpt-6-astra -c model_reasoning_effort=high -C <cloneLocal> - < <prompt-file>

For a follow-up, send a new call carrying the previous exchange.

## Rules

- Read-only everywhere: never push, comment, star or open anything on GitHub; never modify the local clones (no checkout).
- Dates are ISO (YYYY-MM-DD). `diasNoAr`: days from the original merge date to the fix date (`confirmado`) or removal date (`descontinuado`); for `pendente`, days from the merge date to 2026-10-17; otherwise null.
- If GitHub refuses access (auth, rate limit, permission), stop and report it; do not guess.

## Output

`out.json` in the PR's folder:

    {
      "caseId": "...",
      "prOriginal": {"numero": 123, "url": "...", "mergedAt": "YYYY-MM-DD" | null, "nota": "how you found it / differences from the benchmark head"},
      "tps": {
        "<issueId>": {
          "status": "confirmado|pendente|descontinuado|nao_entrou_no_original|nao_verificado",
          "corrigidoEm": {"data": "YYYY-MM-DD", "pr": 456 | null, "commit": "<sha>" | null, "url": "..."} | null,
          "removidoEm": {"data": "...", "pr": ..., "commit": ..., "url": "..."} | null,
          "diasNoAr": 30 | null,
          "reason": "2-4 sentences: what you saw in the upstream code and history that decides the status",
          "astra": [{"pergunta": "...", "resposta": "...", "veredito": "..."}]
        }
      }
    }

Every `issueId` of the input appears exactly once. Write it with a Python script and check that. Use temp files only inside the PR's folder, named `tmp_*`, and delete them at the end.
