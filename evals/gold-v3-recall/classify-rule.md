# Classifying known bugs by defect class

You get the known, confirmed bugs of one pull request (each with an id, a description and, when available, the review comments that reported it with their file and lines) and the list of files the pull request changed. For EACH bug, decide its defect class, and where the code a reviewer must read to see it lives. Read the code at the pull request head with read_file and grep when the description does not settle it.

Classes (pick exactly one, the one that best names the root cause):
- consumer-outside-diff: the change alters a value, field, status, enum, return shape, error behaviour, key or name, and code that READS or CONSUMES it (usually in a file the PR did not change, or in a part of a changed file the PR did not touch) still assumes the old one and breaks or misbehaves.
- sibling-not-updated: the change adds or fixes something in one place (a guard, a check, a field, a normalisation, a handling) and a PARALLEL implementation that needed the same change did not get it: another provider or platform behind the same interface, another entry point to the same use case, another copy of the same helper, another locale or mirror. The sibling keeps the old behaviour or bug.
- edge-case-logic: a wrong condition, boundary, regex, parsing, arithmetic, null or empty handling inside the changed logic itself.
- error-handling: wrong behaviour on failure: swallowed or misclassified errors, wrong fallback, fail-open, timeouts, retries.
- state-concurrency: races, ordering, idempotency, caching, state across calls or runs.
- security: authorization, tenant isolation, injection, secrets, data exposure.
- performance: needless cost, N+1, unbounded work, memory.
- spec-mismatch: the code does not do what its own name, docs, PR description or flag promise.
- other: anything else (dead code, test that does not test, style-level defects, config).

Where:
- in-diff: everything needed to see the bug is in lines the PR added or changed.
- outside-diff: seeing it needs code the PR did not change (another file, or untouched lines of a changed file).

For each bug answer: id, class, where, reason (one sentence). Every bug id gets exactly one answer. When done, call submit_classes once with all answers.
