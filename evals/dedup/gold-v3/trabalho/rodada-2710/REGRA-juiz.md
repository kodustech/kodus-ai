# Matching new review comments to a golden set

A golden set lists, for one pull request, every known REAL problem ("issue"). Each issue has an id, a description, and sometimes the review comments that already reported it and a known-issue text. A new code review produced new comments. For EACH new comment, decide whether it describes one of these real problems or anything else ("new": a different problem, a false claim, or no problem).

Same-problem rule (use exactly this): a comment matches an issue when a developer who fixes what the comment describes would also fix what the issue describes, at the same place in the code. Different wording, extra detail, a different suggested fix, or a broader comment that includes the issue's problem still match. A different bug in the same area, a related symptom, or a different consequence of different code do NOT match. A comment at the same lines as an issue can still be a different problem: read both.


When unsure, read the code at the pull request head (read-only commands).

For each new comment answer:
- match: the issueId it matches, or "new" when it matches none.
- newGroup: only for "new": a label ("N1", "N2", ...) shared by the new comments of this pull request that describe the same new problem (same rule as above); otherwise null.
- reason: one or two sentences naming the shared problem (or why none matches).

Every new comment id gets exactly one answer.
