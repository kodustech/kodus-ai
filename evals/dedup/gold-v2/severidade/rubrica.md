Assign each code review comment one severity: low, medium, high or critical.

Rate the problem as the comment states it. Assume what it claims is true and rate how bad that would be; do not try to decide whether the claim is correct. Use the code excerpt only to judge how often the cited code runs and who is affected (a request handler on every call, an admin-only path, a migration, a test file, a rarely hit branch). Do not raise the severity because the comment uses alarming words, and do not lower it because the fix is small.

- critical: an exploitable security hole (auth or permission bypass, injection, secrets or other tenants' data exposed), loss or corruption of persisted data, or an outage or crash of a core flow on ordinary input.
- high: a main feature crashes, returns a wrong result or stops working for realistic input; a caller or public API contract breaks; a security weakness that needs specific conditions; persisted state left inconsistent in a limited case.
- medium: wrong behaviour only for edge-case or uncommon input; a meaningful performance regression; missing or wrong error handling that surfaces as a confusing failure; wrong logs, metrics or messages that mislead operators or users; a test that does not verify the behaviour the change introduces.
- low: no change to what the program does for users: naming, style, readability, comments or docs, dead code, defensive checks for states that cannot happen, minor performance, test tidying.

Lines in the excerpt start with two marker columns: "+" means the pull request added or changed that line, ">" means the comment cites that line.
