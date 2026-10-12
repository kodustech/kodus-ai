# Task

Below are the code review suggestions one AI reviewer produced for a single pull request, before any deduplication. Several reviewer passes ran independently, so the same problem is often reported more than once, with different wording or slightly different line ranges, and sometimes from a different file.

Group the suggestions that describe the same problem. This is a ground-truth label: be careful and precise. Judge only whether suggestions describe the same problem. Do NOT judge whether a suggestion is correct, important or a real bug: a wrong suggestion still has duplicates.

# Groups: one problem each

A group holds the suggestions that report the same single problem: posting more than one of them on the PR would be redundant. Wording, emphasis, the proposed fix, the category or the line range may differ. Every group is about ONE problem.

Each group gets one kind:

1. `same_location`: same file, overlapping or nearby lines, same problem. Example: three suggestions about the same missing null check, with line ranges 118-119, 117-121 and 118-118.
2. `cross_location`: one problem reported from different files or places. Example: one suggestion points at a broken function's definition, another at the call site that breaks because of it. One fix resolves both.
3. `systemic_pattern`: the same mistake repeated at several distinct places, each needing its own edit, all fixed by one change of approach or one find-and-replace. Example: the same wrong metric name copy-pasted into create(), update() and delete(), reported as three suggestions.

# Suggestions that report more than one problem

Some suggestions report two or more distinct problems in one text (for example "the cache key omits the tenant id, and the TTL is never set"). Do NOT put these in a group, and do NOT let them join two groups together: the suggestions that report only the tenant-id problem form one group, the ones that report only the TTL problem form another group, and the suggestion that reports both is listed in `multiProblem`.

For each `multiProblem` suggestion give:

- `relatedGroups`: the ids of the groups (G1, G2, ...) whose problem this suggestion also reports. Empty when none of its problems has a group.
- `uncoveredProblems`: one short sentence per problem this suggestion reports that is NOT the problem of any group (no other suggestion reports it). Empty when every one of its problems already has a group.

A problem that a suggestion only mentions as context in its explanation, or only touches inside its proposed fix, is not a problem it reports.

# What is NOT the same problem

- Different problems in the same code (a null dereference and an inverted authorization check in the same function). Same lines do not make a duplicate.
- The same symptom with different root causes that need different fixes.
- Same general topic, different concrete problems ("missing validation of X" vs "missing validation of Y" in unrelated places where neither is a repeated copy of the other).

When in doubt, read the diff: decide from what the code actually does, not from wording overlap.

# Confidence

For every group, every `multiProblem` suggestion and every suggestion left unique, give a confidence that your decision is right:

- `high`: clear from the text and the diff; another careful reviewer would decide the same.
- `mid`: probably right, but a reasonable reviewer could decide otherwise.
- `low`: genuinely unsure.

Saying "unique" wrongly is as bad an error as grouping wrongly, so rate unique suggestions with the same care.

# Output

- `groups`: one entry per group, with at least 2 members (suggestion ids that each report only that problem), an `id` (G1, G2, ...), its kind, confidence, `problem` (one sentence naming the problem) and `rationale` (one or two sentences on why these belong together).
- `multiProblem`: every suggestion that reports more than one problem, with `relatedGroups`, `uncoveredProblems`, `problems` (one short sentence per problem it reports) and confidence.
- `unique`: every suggestion that reports one problem no other suggestion reports, with its confidence.

Every suggestion id must appear exactly once: in exactly one group, in `multiProblem`, or in `unique`.
