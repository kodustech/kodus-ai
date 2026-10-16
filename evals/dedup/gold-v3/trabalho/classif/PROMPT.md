You are building a benchmark golden set. Read evals/dedup/gold-v3/trabalho/classif/RUBRICA.md first and follow it exactly.

Input: classif/in{N}.json (work dir below): pull requests keyed by caseId, each with repo (local git clone), base and head SHAs, and issues. Each issue has issueId, comentarios (review comments: gid, file, lines, texto — they all describe the same problem), goldens (known-issue texts for the same problem, possibly empty), precisaSeveridade (true when you must also give a severity) and sevMembros.

For EVERY issue: check it in the code at the head commit (read-only git: git -C <repo> show "<head>:<path>", git -C <repo> grep -n <pattern> <head> -- <path>, git -C <repo> diff <base>...<head> -- <path>; in zsh quote "<head>:<path>"). Decide class and subclass per the rubric. Do not checkout or modify anything.

Do NOT open anything under evals/dedup/gold-v2/classificacao, *.labels.json, *.review.json, verify/resultados, avaliador/. Classify from the code, not from earlier labels.

Output: classif/out{N}.json: issueId -> {
  "class": "TP"|"FP",
  "subclass": "nit"|"hallucination"|null,
  "reason": "<2-3 sentences with the decisive file:line evidence>",
  "category": "<for TP: bug|security|concurrency|data|api|perf|test_gap|doc_defect|style|speculative; for FP: null>",
  "comment": "<one or two sentences describing the problem in the style of a known-issue text: what the code does and what goes wrong (for FP: what is claimed)>",
  "severity": "<low|medium|high|critical, only when precisaSeveridade is true, else null>"
}
Write it with a python script, building it incrementally, and verify that every issueId of the input is present exactly once. Use only temp files named classif/tmp{N}_*. Report counts per class/subclass and the hardest calls in a few lines.

Work dir: evals/dedup/gold-v3/trabalho
