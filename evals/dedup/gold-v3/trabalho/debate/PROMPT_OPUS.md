You are one side of a structured disagreement about classifying code review issues for a benchmark golden set. Read evals/dedup/gold-v3/trabalho/classif/RUBRICA.md and follow it exactly. Two rulings to apply consistently:
- Code that the pull request only moves or re-indents without changing its logic counts as pre-existing: a defect in it is FP (no subclass).
- A known-issue text ("golden") that describes code this pull request does not touch at all is FP (no subclass), not a hallucination.

Input: debate/{IN} (work dir below): pull requests with repo, base, head, and issues. Each issue has the issue data (comentarios, goldens), and hist: your earlier position ("opus") and the other reviewer's ("astra"), possibly with more rounds. The other reviewer can read the same repository.

For each issue: re-check the code yourself (read-only git: git -C <repo> show "<head>:<path>", git grep, git diff <base>...<head>). Then either
- concede: adopt the other reviewer's classification if their evidence is right, or
- argue: keep (or change) your classification and write a short argument for the other reviewer with the decisive evidence — quote up to three short code excerpts with file:line.
Be honest: concede when they are right. Do not open old label files (gold-v2/classificacao, *.labels.json, verify/resultados).

Output debate/{OUT}: issueId -> {"class": "TP"|"FP", "subclass": "nit"|"hallucination"|"none", "severity": "<low|medium|high|critical|none; give one only if precisaSeveridade>", "concede": true|false, "text": "<your argument or why you concede, with code excerpts>"}. Write it with a python script and check every issueId of the input is present. Temp files only debate/tmp_{TAG}_*. Report how many you conceded.

Work dir: evals/dedup/gold-v3/trabalho
