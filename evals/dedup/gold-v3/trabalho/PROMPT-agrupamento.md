You are building a single golden set of code review issues for a benchmark. Four AI reviewers (models ds, gpt, son, muse) reviewed the same pull requests; each one's comments were already deduplicated within that model into "groups". A human-curated list of known issues (the "goldens") also exists per pull request. Your job: for each pull request, merge everything that describes THE SAME PROBLEM into one issue.

Input file (agrup/in{N}.json, in the work dir below): pull requests keyed by caseId. Each has:
- grupos: one entry per model group: gid (e.g. "ds:S4"), model, file, lines, lentes, texto (the group's representative comment), outros (other comments in the same group, same problem).
- goldens: the known issues: idx, comment, severity, category.

Same-problem rule (use exactly this): two items describe the same problem when a developer who fixes what one describes would also fix what the other describes, at the same place in the code. Different wording, extra detail, or a broader comment that includes the other problem still counts as the same problem. A different bug in the same area, a related symptom, or a different consequence of different code does NOT. Two comments at the same lines can still be different problems — read them.

Rules:
- Every gid of the pull request must appear in exactly one issue. Every golden idx must appear in exactly one issue.
- An issue can hold groups from several models, the same model more than once (if that model's dedup missed a duplicate), and at most the goldens that describe that same problem (normally zero or one).
- A golden that matches no group becomes an issue alone. A group that matches nothing stays an issue alone.
- When unsure whether two items are the same problem, read the code: the repo for each pull request is a local git clone. Look up its path and head commit in evals/dedup/gold-v3/trabalho/repos.json (caseId -> {repo, head}); use read-only commands such as git -C <repo> show "<head>:<path>". Do not modify anything.
- Do NOT open anything under evals/dedup/gold-v2/classificacao, *.labels.json, severidade/, or any verify/results folder. This grouping must not depend on old TP/FP labels.

Output: write agrup/out{N}.json (same work dir), an object: caseId -> list of issues, each {"gids": [...], "goldens": [idx,...], "note": "<one short sentence naming the shared problem>"}. Write it with a python script, then verify for every pull request that all gids and all golden idx appear exactly once. Report the number of issues, how many contain 2+ models, and how many contain a golden. Use only temp files named agrup/tmp{N}_* — other agents share this directory.

Work dir: evals/dedup/gold-v3/trabalho
