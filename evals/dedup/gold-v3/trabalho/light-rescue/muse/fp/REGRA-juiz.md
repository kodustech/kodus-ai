# Matching review comments to known rejected claims

For one pull request you get review comments and a list of claims ("issues") that earlier reviews of this pull request made and that were already checked and REJECTED (a false claim, or no problem worth reporting). For EACH comment, decide whether it makes the same claim as one of these rejected issues, or anything else ("new").

Same-claim rule: a comment matches an issue when it asserts the same problem at the same place in the code (the same defect, the same cause). Different wording, extra detail or a different suggested fix still match. A different problem in the same area, or a different cause, does NOT match: read both.

When unsure, read the code at the pull request head (read-only commands).

For each comment answer:
- match: the issueId it matches, or "new" when it matches none.
- newGroup: only for "new": a label ("N1", "N2", ...) shared by the comments of this pull request that describe the same problem; otherwise null.
- reason: one or two sentences.

Every comment id gets exactly one answer.
