---
name: kodus-cockpit-usage
description: Use when the user asks for Kodus metrics or spend — Cockpit numbers (PR cycle time, lead time, deploy frequency, bug ratio, PR size, implementation rate of Kody's suggestions, 👍/👎 feedback, ignored criticals, repository or Kody Rules health, delivered-as-asked, code hotspots) or token usage and cost (by day, PR, developer, review run or model) — via `kodus cockpit <tab>` and `kodus usage tokens`.
---

# Kodus Cockpit and Token Usage

## Overview

The web app's Cockpit and Token Usage pages, read from the terminal. Each command calls the same endpoints the page renders, with the logged-in user's permissions, so the numbers match what the user sees in the browser for the same team, period and filters.

## Goal

Answer questions about the team's review metrics and LLM spend with these commands, instead of sending the user to the web app.

## Trigger Hints

- "cycle time", "lead time", "deploy frequency", "how many PRs merged", "PR size", "bug ratio", "who merged the most PRs".
- "implementation rate", "how many suggestions were implemented", "thumbs down", "negative feedback", "ignored criticals", "which rules are noisy", "repository health".
- "delivered as asked", "PRs against their task", "code hotspots", "fragile areas".
- "token usage", "how much did we spend", "cost by model", "cost per PR", "which developer used the most tokens".

## Workflow

Unless specifically stated, YOU must run the Kodus CLI commands on behalf of the user.

1. These commands need a logged-in user (team keys do not cover them). If a command fails with an auth error, ask the user to run:

```bash
kodus auth login
```

2. Pick the command from the question.

| Question about                                                                                                                                  | Command                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Deploys, cycle/lead time, bug ratio, PR size, PRs opened vs closed, PRs per developer, team activity                                            | `kodus cockpit productivity`                                  |
| Kody's suggestions implemented, by category/severity, 👍/👎, ignored criticals, review success/error/skip, repository health, Kody Rules health | `kodus cockpit kodus-review`                                  |
| PRs checked against their task (business logic validation)                                                                                      | `kodus cockpit intent`                                        |
| Areas of a repository that change most and carry bug fixes                                                                                      | `kodus cockpit code-areas --repo owner/name`                  |
| Tokens, cost, previous-period comparison                                                                                                        | `kodus usage tokens --by daily\|pr\|developer\|review\|model` |

3. Translate the period and scope into flags.

- `--from YYYY-MM-DD --to YYYY-MM-DD`. Default is the last 15 days, the same default as the web app. Convert "last month", "this week", "since October" into explicit dates.
- `--repo owner/name` (or the repository id) to scope to one repository. Without it, the Cockpit covers all repositories.
- `--team <name|id>` when the organization has more than one team; the error lists the teams.
- Usage only: `--developer <name>`, `--pr <number>`.

```bash
kodus cockpit productivity --from 2026-10-01 --to 2026-10-31 --json
kodus usage tokens --by model --from 2026-10-27 --to 2026-11-02 --json
```

4. Read the JSON and answer the question.

- `kodus cockpit` returns `{ tab, team, range, repository, metrics, errors }`. `metrics` holds one payload per card, keyed by name (`deployFrequency`, `prCycleTime`, `implementationRateWeekly`, ...). A metric whose endpoint failed is `null` and listed in `errors`; say it is unavailable rather than reporting zero.
- Review-analytics rates (`rate`, `negativeRate`, `successRate`, `metRate`) are fractions 0..1. The bug-ratio highlight `ratio` is already a percentage.
- The implementation rate shown on the Kodus Review card is the sum of `implemented` over the sum of `sent` across `implementationRateWeekly`.
- `kodus usage tokens` returns `{ summary, previousPeriod, rows, byTaskArea, activeDays, pullRequests }`. `summary.totalCost.total` is the cost in USD; `rows` is the breakdown chosen with `--by`.

## Output Guidance

- Always use `--json` and summarize; quote the period and scope you used.
- Compare with the previous period when the payload has it (`comparison.percentageChange`, `previousPeriod`).

## Safety Notes

- Read-only commands. A 403 means the user's role or plan has no access to the Cockpit or Token Usage; tell them, do not retry with other credentials.
