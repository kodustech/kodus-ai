# Classifying a code review issue

An "issue" is one problem in a pull request, described by one or more review comments and/or by a known-issue text ("golden"). Decide whether the problem is real by READING THE CODE at the pull request head. Never trust a comment's or a golden's description of the code: the golden text is not proof, some goldens describe problems that do not exist.

Classes:

TP — the problem really exists in the code at the pull request head, and this pull request introduces it or changes the code involved. Subclass:
- nit: real, but not worth a reviewer's comment: naming, style, wording, comments/docs/Javadoc/docstrings that are inaccurate without changing behaviour, dead or no-op code, micro-optimisations, redundant work with no user effect, test naming or tidying, log field/context details. A developer would not want this on their pull request.
- (none): a real defect worth reporting: wrong behaviour, crash, wrong result, security problem, data loss or inconsistency, broken caller or contract, meaningful performance problem, a test that does not verify the behaviour it was written for, missing error handling that surfaces as a failure.

FP — no real problem to report in this pull request. Subclass:
- hallucination: a fact the issue relies on is false (the code does not call, contain, pass, return or configure what is claimed), or the described problem is impossible given the code, or the text is absurd, garbled or unrelated to the code.
- (none): the facts are right but there is no problem to report: a guard for a state no code path can reach, a "verify that / consider" request with no defect, behaviour that is correct or intended, a comment that reports no problem ("no issue found", empty), or a real defect that existed before this pull request in code the pull request does not touch.

Severity (only when asked): rate the problem as the issue states it, assuming it is true — use evals/dedup/gold-v2/severidade/rubrica.md (low, medium, high, critical).

Category (for TP): bug, security, concurrency, data, api, perf, test_gap, doc_defect, style, speculative.
