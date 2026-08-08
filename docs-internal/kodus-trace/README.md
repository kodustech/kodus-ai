# Kodus Trace — UI evidence

Screenshots of `kodus trace ui` taken against a real captured session, for the
pull request that shipped the feature (#582).

They live here rather than as PR attachments because the GitHub API cannot
upload images: only the web UI can, and the acceptance criteria ask for them in
the PR.

| File | View |
|---|---|
| `kodus-trace-ui-session-list.png` | Session list — one row per session with date, branch, agent, turn count and files touched |
| `kodus-trace-ui-session-detail.png` | Session detail — decisions from the session, then the turns in order with prompt, response, tool calls and files modified |
| `kodus-trace-ui-empty-state.png` | Empty state — a repository where nothing has been captured yet |

The prompt in the detail view carried a fabricated credential; it renders as
`[REDACTED]` because redaction runs before anything is written.
