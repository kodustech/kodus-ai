# Task

Below are the code review suggestions one AI reviewer produced for a single pull request, before any deduplication. Several reviewer passes ran independently, so the same problem is often reported more than once, with different wording or slightly different line ranges, and sometimes from a different file.

Group the suggestions that are duplicates of each other. This is a ground-truth label: be careful and precise. Judge only whether suggestions describe the same defect. Do NOT judge whether a suggestion is correct, important or a real bug: a wrong suggestion still has duplicates.

# What counts as a duplicate

Two suggestions are duplicates when they describe the same defect: posting both on the PR would be redundant. Wording, emphasis, the proposed fix, the category or the line range may differ.

Each group gets one kind:

1. `same_location`: same file, overlapping or nearby lines, same defect. Example: three suggestions about the same missing null check, with line ranges 118-119, 117-121 and 118-118.
2. `cross_location`: one defect reported from different files or places. Example: one suggestion points at a broken function's definition, another at the call site that breaks because of it. One fix resolves both.
3. `systemic_pattern`: the same mistake repeated at several distinct places, each needing its own edit, all fixed by one change of approach or one find-and-replace. Example: the same wrong metric name copy-pasted into create(), update() and delete(), reported as three suggestions. These ARE duplicates.

**Overlapping suggestions are duplicates too.** When one suggestion is part of another (the larger one reports the same defect plus extra defects), or two suggestions share a defect and each adds something else, they belong in the same group. Example: A reports "stale cached grantType after setFormParams() + NPE when formParams is null", B reports only the NPE, C reports "stale grantType + removed copy constructor": A, B and C form one group. Chains count: if A overlaps B and B overlaps C, all three go together. Use the kind that fits where the members point (usually `same_location`).

`needsUnifiedComment`: true when the single comment that replaces the group must carry more than any one member says: members point at distinct code locations that each need their own edit, or members report different extra defects that must all survive in the merged comment. Always true for `systemic_pattern`. True for an overlapping group whose members together report more than one defect. False when every member reports the same single defect and one edit at one place resolves it.

# What is NOT a duplicate

- Different defects in the same code, with no defect in common (a null dereference and an inverted authorization check in the same function). Same lines do not make a duplicate.
- The same symptom with different root causes that need different fixes.
- Same general topic, different concrete problems ("missing validation of X" vs "missing validation of Y" in unrelated places where neither is a repeated copy of the other).

When in doubt, read the diff: decide from what the code actually does, not from wording overlap.

# Confidence

For every group and for every suggestion left unique, give a confidence that your decision is right:

- `high`: clear from the text and the diff; another careful reviewer would decide the same.
- `mid`: probably right, but a reasonable reviewer could decide otherwise.
- `low`: genuinely unsure.

Saying "unique" wrongly is as bad an error as grouping wrongly, so rate unique suggestions with the same care.

# Output

- `groups`: one entry per duplicate group, with at least 2 members (the suggestion ids), its kind, needsUnifiedComment, confidence, `defect` (one sentence naming the defect, or every defect the merged comment must carry) and `rationale` (one or two sentences on why these belong together).
- `unique`: every suggestion that is in no group, with its confidence.

Every suggestion id must appear exactly once: either in exactly one group or in `unique`.
