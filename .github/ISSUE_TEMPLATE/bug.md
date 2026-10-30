---
name: Bug report
about: Report something that is broken
title: ''
labels: ['🐛 bug']
assignees: ''
---

### What happened

The behavior you observed, in past tense. What you saw, not what you think is causing it.

### Steps to reproduce

1. (for example) Went to ...
2. Clicked on ...
3. ...

If you could not reproduce it, say so here and list what you tried. "Not reproducible from these steps, here is what was attempted" is a useful report.

### Expected result

What the system should have done.

### Actual result

What it did instead.

### Evidence

Exact error text, correlation or request ids, timestamps with the timezone, screenshots or a recording, versions (app, Node, browser), and the provider or model when the failing path depends on one. Paste the real strings rather than a summary of them.

There is no length limit here. Evidence is the part of a report nobody can reconstruct later.

### Impact

How many occurrences, since when, and how many organizations or repositories are affected, with the query or log search that produced those numbers. Write `unknown` when you cannot measure it. Avoid "several", "many" and "constantly", since nobody can prioritize on an adjective.

### Cause (only if you read the code)

Leave this section out unless you opened the code. If you did, cite `path/file.ts:line` and the branch or version you read, and describe the mechanism. Keep the fix out of it: which layer changes, and how, is decided in the design step.

### Still unverified

Anything above you could not check. If this list is empty and you did not reproduce the bug, look again.

---

For whoever picks this up, human or agent: the cause above was read at the cited version. Confirm it still holds in the current code before changing anything, and correct this issue if it does not. Do not ship a fix for a cause this report did not prove.
