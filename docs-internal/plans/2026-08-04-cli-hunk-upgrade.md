# CLI × Hunk — upgrade notes and review-UX roadmap

Date: 2026-08-04
Scope: `apps/cli`
Baseline: `hunkdiff@0.12.1` (May 2026) → `hunkdiff@0.18.0-beta.0` (Aug 2026)

## What shipped in this change

1. **`hunkdiff` bumped 0.12.1 → 0.18.0-beta.0.** Deliberately the `beta`
   dist-tag, not `latest` (0.17.7): the extension API we build on below only
   exists in 0.18. See "Risk of the beta pin" at the bottom.
2. **Review scopes now route to hunk.** `--branch`, `--commit` and explicit file
   arguments used to fall back to the legacy inquirer list; hunk understands
   `hunk diff <range>`, `hunk show <ref>` and `-- <pathspec…>`, so all of them
   now open the TUI (`features/review/hunk-viewer.ts`).
3. **A Kodus findings sidebar**, shipped as a bundled hunk extension
   (`apps/cli/hunk-extension/kodus`) and loaded with `--extension`.
4. **Rewritten inline notes** using STML (`--experimental`), which also fixed
   three separate ways the old notes silently dropped text — see below.
5. **Worktree fix** (unrelated to hunk): hook paths resolve through
   `git rev-parse --git-path hooks` instead of `<root>/.git/hooks`.

### What the bump buys us for free

| Area | Versions | Impact |
| --- | --- | --- |
| Large-review scroll / hunk navigation latency | 0.15.3 | ~100–1000× faster |
| Retained memory in big reviews | 0.15.1, 0.15.3, 0.17.1, 0.18 | geometry + highlight caches capped |
| Inline context expansion (`z`, `▾ N unchanged lines`) | 0.14.0 | read around a finding without leaving the review |
| Open file in `$EDITOR` (`e`), incl. line numbers | 0.13.0, 0.15.1, 0.17.0 | jump from a finding straight to the fix |
| `,` / `.` file navigation, `g`/`G` | 0.13.0 | faster movement between findings |
| Moved-line highlighting (`colorMoved`) | 0.15.0 | refactor noise separated from real changes |
| Themes: default `github-dark-default`, `t` selector, Catppuccin/Zenburn, custom palettes | 0.14.0–0.16.0 | |
| Mouse-drag selection + OSC 52 copy | 0.14.0 | copy a finding out of the TUI |
| Configurable `[keybindings]`, Extensions menu | 0.18.0 | every command we register is user-remappable |
| Windows launches from Cygwin / Git Bash / WSL | 0.15.3 | see "Windows" below |
| Session daemon hardening (Host/Origin validation, body caps, timeouts) | 0.13.1, 0.15.1 | prerequisite for the live-session work below |
| CJK / emoji alignment, wrapping, selection | 0.14.0–0.17.6 | |

## The Kodus findings sidebar

`kodus review` now spawns hunk with `--extension <pkg>/hunk-extension/kodus`
and hands the extension a structured sidecar through `KODUS_HUNK_FINDINGS`.

Why a second sidecar rather than reusing `--agent-context`: that payload is
hunk's own inline-note schema, and it flattens severity into a glyph inside a
prose string. The sidebar needs severity back as data, so
`features/review/hunk-findings.ts` writes `{file, line, endLine, severity,
title, category, ruleId}` alongside it.

What the pane does that hunk's inline notes don't: inline notes answer "what is
wrong with this line?" once you are already looking at it. The pane answers
what a file-ordered diff cannot — "what are the worst things in this changeset,
and where?" — so it sorts **by severity, not by path**:

```
 Kodus · 3 findings
 ‼1  ✖1  ℹ1
 ‼ src/a.ts:3
   eval() on a value derived from a hardcoded credential is remote code execution
 ✖ src/a.ts:2
   Hardcoded password committed to source
 ℹ src/b.ts:2
   Prefer const over let for a value that is never reassigned
```

Keys (defaults; remappable via hunk's `[keybindings]` as `kodus.*`):

| Command | Key | Does |
| --- | --- | --- |
| `kodus.toggle` | `y` | show/hide the pane |
| `kodus.next` | `n` | jump to the next finding, severity-first |
| `kodus.previous` | `p` | previous finding |

`n`/`p` are deliberately not hunk's `}` / `{` (next *annotated* hunk, document
order): a `critical` three files down comes before an `info` in the current
file.

Implementation notes:

- The pane is `defaultOpen` only when the review has findings — an empty panel
  stealing width from the diff is worse than no panel. Hunk still owns pane
  arrangement, so at narrow terminal widths it drops the sidebar area entirely
  (the built-in file nav included); `y` or `s` brings it back.
- Kodus reviews whole files while hunk only renders changed spans, so a finding
  can land outside every hunk. `findHunkIndex` falls back to the nearest hunk
  rather than refusing to navigate.
- Path matching is exact-first with a path-segment suffix fallback, so a review
  scoped to a subdirectory still resolves.
- The pure logic lives in `hunk-extension/kodus/findings.ts` (no JSX, types
  only) so it is unit-tested from `src/features/review/__tests__/`. The `.tsx`
  entry sits outside `src/` so our `tsc` never compiles it — hunk runs it.
- Verified end-to-end by driving the real TUI in a pty: pane renders, `y`
  toggles, `n`/`p` walk findings and move the review stream.

## Live validation (2026-08-04)

Ran a real `kodus review` against the production API on this very changeset
(13 files, ~10 min, `Found 3 issues in 13 files (1 critical)`), then drove the
real TUI in a pty. It caught three things worth recording.

**1. `getHooksDir()` fallback was wrong — Kody found it.**
`git rev-parse --git-common-dir` prints an absolute path inside a linked
worktree but a *cwd-relative* one in an ordinary checkout (`../../.git` from a
nested directory). Resolving it against `--show-toplevel` climbed above the
repo. Reproduced, fixed against `process.cwd()`, and covered by a new
subdirectory case in `worktree-e2e.test.ts`.

**2. `/cli/review` is not run through the severity normalizer.**
`ReviewIssue.severity` is typed `Severity` (`info|warning|error|critical`) but
the live endpoint returned `"high"`. `normalizeSeverity` is only wired into the
*suggestions* path (`review-normalizer.ts`), never into `/cli/review`. Left
unmapped, `high` sorted ahead of `critical` in the sidebar and rendered an
undefined glyph. `convertReviewToHunkFindings` now normalizes, and the
extension coerces defensively on its own side (the sidecar is a file on disk).
The pre-existing `hunk-context.ts` degrades gracefully here, which is why the
inline notes never showed the problem — worth normalizing at the API boundary
instead, as a follow-up.

**3. The `y` toggle did nothing on a narrow terminal.**
Hunk drops the whole sidebar *area* when the diff is wide relative to the
terminal, and an extension cannot ask whether the area is visible. With
`defaultOpen: true` the view was nominally open, so `y` *closed* a pane the
user had never seen. The first press now always `open()`s (which reveals the
area); it toggles normally after that. Verified at 140 columns: one `y` reveals
the pane.

Also verified end-to-end with real API output: `--extension` reaches hunk, the
`KODUS_HUNK_FINDINGS` sidecar is read, the pane renders `Kodus · 3 findings`
with `‼1 ✖2`, and `n` walks findings severity-first while moving the review
stream.

### Open follow-up: `@opentui` peer mismatch

Kody's third finding is real. `hunkdiff@0.18.0-beta.0` declares peers
`@opentui/core ^0.4.3` / `@opentui/react ^0.4.3`, but pnpm's auto-install-peers
resolved `0.1.107` — 12 MB in `node_modules` at a version that does not satisfy
the range. No runtime impact: hunk ships a prebuilt binary (81 MB for
darwin-arm64) with opentui compiled in, and it serves its own React/OpenTUI to
extension files at import time, which the pty runs confirm. So this is install
weight and a wrong type-resolution target for the extension's type-only
`@opentui/core` import, not a correctness bug. Not touched here to avoid
another lockfile churn; fix is either pinning `^0.4.x` explicitly or an
`ignoreMissing` peer rule.

## Inline notes: STML rewrite

`--agent-context` notes were built as one wrapped paragraph, which is all the
plain-text schema allows. Reviewing real output showed that shape was not just
ugly — it lost content, in three independent ways, each found only after the
previous fix. All three are now covered by invariant tests
(`hunk-context.test.ts`) rather than formatting assertions, because this bug
kept coming back through a different door.

1. **The summary cap ate the message.** The first sentence became the note's
   summary, capped at 140 chars with `…`, and the body started from the
   *second* sentence — so the tail of any long first sentence existed nowhere.
   The body now always carries the full text; the summary is just a label.
2. **Code was reflowed as prose.** The API's `suggestion` is usually a patch.
   `<code>` is verbatim, so the fix now gets its own block — but `code` *clips*
   rather than wraps, so a prose lead-in placed there lost its tail. `splitAdvice`
   separates the introducing sentence from the snippet.
3. **Code blocks clip long lines.** Both `<code>` and `<pre>` truncate at the
   pane edge with no ellipsis. `wrapCodeBlock` hard-wraps with a hanging indent
   before emitting.

   Picking that width took two attempts. A `columns / 2 - 8` estimate looked
   reasonable and still clipped on a 238-column terminal. Measuring the real
   interior by pushing a ruler through the live TUI explains why:

   | terminal | usable | | terminal | usable |
   | --- | --- | --- | --- | --- |
   | 80 | 55 | | 160 | 61 |
   | 100 | 75 | | 180 | 71 |
   | 120 | 95 | | 200 | 85 |
   | 140 | 119 | | 238 | 87 |
   | | | | 300 | 114 |

   It is not monotonic in terminal width: 238 is narrower than 140. Usable
   width drops at 160 when hunk switches to a split diff, and drops again once
   the sidebar area reappears and claims its share — plus the user can resize
   panes by hand. `process.stdout.columns` predicts none of that, so the width
   is now the STML guide's own ~56-column recommendation (52 after the frame),
   relaxed only at the narrow end where the stack layout is predictable.
   Wrapping early on a wide terminal is cosmetic; clipping loses text.

Also fixed while reading real Kody-rule findings:

- **Markdown leaked verbatim.** `[rule name](https://app.kodus.io/…)` rendered
  as literal syntax with a 100-char URL wrapped mid-sentence, plus backslash
  escapes (`exceções\.`). `extractMarkdownLinks` keeps the label inline and
  moves the URL to a dim trailing paragraph. Note STML's `<a>` is *not* usable
  here: it renders the label and discards the href entirely — no OSC 8 either —
  so the URL has to survive as text.
- **Severity was unnormalized here too**, so `high` produced no glyph and an
  `info`-coloured badge.
- **Raw UUID rule ids** were repeated in the attribution line next to the same
  id inside the rule URL; UUID-shaped ids are now dropped, named ones kept.

The plain-text `rationale` remains a complete fallback for when STML is
rejected or `--experimental` is absent.

## Recommended next steps

### 1. Live session round-trip

Since 0.13 hunk runs a local session daemon with a full control surface:

```
hunk session list | get | context | review [--json] [--include-patch]
hunk session navigate --repo . --file <p> (--hunk n | --new-line n)
hunk session reload   --repo . -- diff <target> [-- <pathspec>]
hunk session comment  add | apply --stdin | list [--type user] | rm | clear
```

Verified working: launched `hunk diff` in a pty, pushed a finding with
`comment apply --stdin --focus`, read it back with `comment list` and
`session review --json`.

Two wins:

- **Push findings into an already-open hunk instead of spawning a nested TUI.**
  Today `kodus review` blocks until the whole review lands, then takes over the
  terminal. Instead: if `hunk session get --repo <root>` resolves, stream each
  finding in as it arrives. Also fixes the "I already have hunk open" case.
- **Read the human's notes back out.** `comment list --type user` returns
  human-authored inline notes — that closes the loop for `kodus fix`: review in
  hunk, mark what you actually want fixed, and `kodus fix` acts on exactly
  those instead of guessing. Today the hand-off is one-way.

### 2. Deepen the sidebar

Now that the extension exists, cheap additions on the same API:

- `ctx.dialogs.confirm` + a `kodus.fix` command to send the selected finding to
  `kodus fix` without leaving the review.
- Dismiss/accept state per finding, surfaced back to the API on exit.
- `transformChangeset` to collapse files with no findings when a review is
  large.

### 3. Ship hunk's agent skill through `kodus skills`

`hunk skill path` prints a bundled `hunk-review/SKILL.md` teaching an agent to
drive a live session. We already have a skills sync pipeline
(`utils/skills-sync*.ts`); re-exporting it lets Claude/Codex narrate a Kodus
review inside the user's open hunk window.

### 4. Revisit STML when it stabilizes

Shipped now (see "Inline notes" above), but behind hunk's `--experimental`
flag and an explicitly unstable tag vocabulary. When STML leaves experimental,
re-check the note layout against whatever the tag set has become, and drop
`wrapCodeBlock` if `code` gains real wrapping.

### 5. Windows

`isHunkPlatformSupported()` returns `false` for `win32` with a comment claiming
hunkdiff ships no Windows binary. That is **not accurate** —
`hunkdiff-windows-x64` has been an optional dependency since at least 0.12.1,
and 0.15.3 fixed launches from Cygwin / Git Bash / WSL-style paths. Left
disabled because we have no Windows machine to verify on; flipping it (gated to
`x64`) should be a small, separately-tested change.

## Risk of the beta pin

`0.18.0-beta.0` is the `beta` dist-tag, not `latest`. The extension API is
explicitly experimental — "the `hunkdiff/extension` surface may change in
breaking ways between minor releases while it stabilizes" — and `hunk.apiVersion`
(currently `2`) identifies the generation an extension was written against.

Containment already in place:

- A broken extension is skipped with a startup notice; a component that throws
  costs the pane, not the session. Review still works.
- `resolveKodusExtensionDir()` returns null when the folder is absent, and
  `buildHunkArgs` simply omits `--extension` — so a build without it degrades
  to plain hunk.

Still worth doing before a release: pin the exact version (no `^`), and re-run
the pty smoke test on every hunkdiff bump.

## Unrelated bug found while auditing

`services/git-hooks.service.ts` installs a `prepare-commit-msg` hook that looks
for sessions in `$(git rev-parse --git-common-dir)/kody-sessions`, but
`services/session-local.service.ts` writes them to `<repoRoot>/.kody/sessions`.
Nothing writes `kody-sessions`, so the `Kody-Checkpoint:` trailer never fires.
The service also has no production caller — only tests reference it. Needs a
decision: wire it up against the real session dir, or delete it.
