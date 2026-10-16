# 2026-10-03 — earlier suggestions across rounds (#2039, #2020, repeats)

`deepseek-v4-flash@fireworks`, judge `gpt-5.6-luna` (low), 3 reps, both sides on
main `14439a953`.

- `main/` — main without the change.
- `branch-v3/` — the change as shipped: R cases with history.
- `branch-v2/` — the shipped change minus one later edit (the finder's
  `revisesSuggestionId` was offered without history too); for these cases
  (all with history, or U4/U5 with neither), the shipped behaviour is the same.

Nightly finder-recall (`--set=light`, same model and judge), 25 PRs measured in
every run: recall main 48.1% / 48.8%, field always offered 43.8% / 42.8%,
shipped (field only with history) 48.6%; precision main 60.8% / 55.0%,
shipped 61.8%. Floor gate OK.
