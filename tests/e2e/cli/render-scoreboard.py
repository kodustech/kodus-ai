#!/usr/bin/env python3
"""Render the aggregated E2E matrix evidence as a run-page scoreboard.

The matrix runner already writes rich evidence per cell (result.json,
notify.json, summary.md) but none of it reaches the Actions run page: every
job is green by design (advisory failures don't gate), so the run reads as
"all passed" even when scenarios failed or coverage silently shrank. This
script turns the downloaded evidence into:

  - a scoreboard on $GITHUB_STEP_SUMMARY (per-cell numbers, advisory
    failures with reasons, setup skips, per-cell drill-down),
  - ::warning:: / ::error:: annotations so the run page itself shows a
    count next to the green check,
  - $GITHUB_OUTPUT values (digest, advisory_count, setup_skipped,
    gating_count) for the caller's Discord notification.

Stdlib only — the aggregate job has no node_modules. Never exits non-zero:
visibility must not change the gate.

Usage: render-scoreboard.py [evidence-dir]
"""

import glob
import json
import os
import re
import sys

MAX_EMBED_BYTES = 60_000  # per-cell summary.md cap; step summary total is 1MiB
MAX_REASON_CHARS = 300


def load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def one_line(text, limit=MAX_REASON_CHARS):
    flat = re.sub(r"\s+", " ", str(text or "")).strip()
    return flat[:limit] + ("…" if len(flat) > limit else "")


def cell_label(results):
    for row in results:
        cell = row.get("cell") or {}
        if cell.get("provider"):
            return "{} × {}".format(
                cell.get("provider"), cell.get("license") or "?"
            )
    return "?"


def collect(evidence_dir):
    cells = []
    for path in sorted(
        glob.glob(os.path.join(evidence_dir, "**", "result.json"), recursive=True)
    ):
        result = load_json(path)
        if not result or not result.get("results"):
            continue
        run_dir = os.path.dirname(path)
        rows = result["results"]
        notify = load_json(os.path.join(run_dir, "notify.json")) or {}

        passed = sum(1 for r in rows if r.get("status") == "passed")
        failed = sum(1 for r in rows if r.get("status") == "failed")
        setup_skips = [
            r for r in rows
            if r.get("status") == "skipped" and r.get("skipKind") == "setup"
        ]
        not_applicable = sum(
            1 for r in rows
            if r.get("status") == "skipped" and r.get("skipKind") != "setup"
        )

        cells.append({
            "label": cell_label(rows),
            "verdict": notify.get("verdict", "?"),
            "passed": notify.get("passed", passed),
            "executed": notify.get("executed", passed + failed),
            "applicable": notify.get("applicable", len(rows) - not_applicable),
            "gating": notify.get("gatingFailures", []),
            "advisory": notify.get("advisoryFailures", []),
            # Fall back to the raw failed rows when notify.json is absent
            # (pre-verdict artifact): an unclassified failure must not vanish.
            "unclassified_failed": [] if notify else [
                {
                    "cell": "{} × {}".format(r.get("scenarioId"), cell_label(rows)),
                    "priority": "?",
                    "error": r.get("errorMessage", ""),
                }
                for r in rows if r.get("status") == "failed"
            ],
            "setup_skips": [
                {
                    "scenario": r.get("scenarioId"),
                    "reason": (r.get("evidence") or {}).get("skipReason", ""),
                }
                for r in setup_skips
            ],
            "flaky": notify.get("retriedCells", []),
            "unverified": notify.get("unverified", []),
            "summary_md": os.path.join(run_dir, "summary.md"),
        })
    return cells


def verdict_icon(verdict):
    return {"green": "🟢", "red": "🔴", "inconclusive": "🟡"}.get(verdict, "⚪")


def render_markdown(cells):
    out = []
    out.append("## E2E self-hosted matrix — scoreboard\n")
    out.append("| Cell | Verdict | Passed | Executed / applicable | Gating | Advisory | Setup skips |")
    out.append("|---|---|---|---|---|---|---|")
    for c in cells:
        out.append(
            "| `{}` | {} {} | {}/{} | {}/{} | {} | {} | {} |".format(
                c["label"], verdict_icon(c["verdict"]), c["verdict"],
                c["passed"], c["executed"], c["executed"], c["applicable"],
                len(c["gating"]) or "—",
                len(c["advisory"]) + len(c["unclassified_failed"]) or "—",
                len(c["setup_skips"]) or "—",
            )
        )
    out.append("")

    gating = [(c, f) for c in cells for f in c["gating"]]
    advisory = [(c, f) for c in cells for f in c["advisory"] + c["unclassified_failed"]]
    unverified = [(c, u) for c in cells for u in c["unverified"]]
    setup = [(c, s) for c in cells for s in c["setup_skips"]]
    flaky = [(c, f) for c in cells for f in c["flaky"]]

    if gating:
        out.append("### 🔴 Gating failures\n")
        for _, f in gating:
            out.append("- `{}` — {}".format(f.get("cell"), one_line(f.get("error") or f.get("reason"))))
        out.append("")
    if unverified:
        out.append("### 🟡 Cells NOT verified (no result — this is not a pass)\n")
        for _, u in unverified:
            out.append("- `{}` — {}".format(u.get("cell"), one_line(u.get("error") or u.get("reason"))))
        out.append("")
    if advisory:
        out.append("### ⚠️ Advisory failures (non-gating — the run is still green)\n")
        for _, f in advisory:
            out.append("- **{}** `{}` — {}".format(
                f.get("priority", "?"), f.get("cell"), one_line(f.get("error"))))
        out.append("")
    if setup:
        out.append("### ⏭️ Setup skips — planned coverage that did NOT run\n")
        for c, s in setup:
            out.append("- `{}` × `{}` — {}".format(
                s["scenario"], c["label"], one_line(s["reason"])))
        out.append("")
    if flaky:
        out.append("### 🔁 Passed only on retry (flaky)\n")
        for c, f in flaky:
            out.append("- `{}` × `{}`".format(f, c["label"]))
        out.append("")

    for c in cells:
        try:
            with open(c["summary_md"]) as fh:
                body = fh.read(MAX_EMBED_BYTES)
        except OSError:
            continue
        out.append("<details><summary><code>{}</code> — full scenario table</summary>\n".format(c["label"]))
        out.append(body)
        out.append("\n</details>\n")

    return "\n".join(out) + "\n"


def emit_annotations(cells):
    for c in cells:
        for f in c["gating"]:
            print("::error title=E2E gating failure::{} — {}".format(
                f.get("cell"), one_line(f.get("error") or f.get("reason"))))
        for u in c["unverified"]:
            print("::error title=E2E cell not verified::{} — {}".format(
                u.get("cell"), one_line(u.get("error") or u.get("reason"))))
        for f in c["advisory"] + c["unclassified_failed"]:
            print("::warning title=E2E advisory failure ({})::{} — {}".format(
                f.get("priority", "?"), f.get("cell"), one_line(f.get("error"))))
        for s in c["setup_skips"]:
            print("::warning title=E2E setup skip (coverage gap)::{} × {} — {}".format(
                s["scenario"], c["label"], one_line(s["reason"])))


def emit_outputs(cells):
    passed = sum(c["passed"] for c in cells)
    executed = sum(c["executed"] for c in cells)
    applicable = sum(c["applicable"] for c in cells)
    gating = sum(len(c["gating"]) for c in cells)
    advisory = sum(len(c["advisory"]) + len(c["unclassified_failed"]) for c in cells)
    setup = sum(len(c["setup_skips"]) for c in cells)
    unverified = sum(len(c["unverified"]) for c in cells)

    parts = ["{}/{} passed".format(passed, executed)]
    if executed != applicable:
        parts.append("executed {}/{} applicable".format(executed, applicable))
    if gating:
        parts.append("{} gating".format(gating))
    if unverified:
        parts.append("{} not verified".format(unverified))
    if advisory:
        parts.append("{} advisory".format(advisory))
    if setup:
        parts.append("{} setup-skips".format(setup))
    digest = " · ".join(parts)

    gh_output = os.environ.get("GITHUB_OUTPUT")
    lines = [
        "digest={}".format(digest),
        "gating_count={}".format(gating),
        "advisory_count={}".format(advisory),
        "setup_skipped={}".format(setup),
    ]
    if gh_output:
        with open(gh_output, "a") as fh:
            fh.write("\n".join(lines) + "\n")
    else:
        print("\n".join(lines))


def main():
    evidence_dir = sys.argv[1] if len(sys.argv) > 1 else "evidence"
    cells = collect(evidence_dir)
    if not cells:
        print("::warning title=E2E scoreboard::no result.json found under {} — nothing to render".format(evidence_dir))
        return

    markdown = render_markdown(cells)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a") as fh:
            fh.write(markdown)
    else:
        print(markdown)

    emit_annotations(cells)
    emit_outputs(cells)


if __name__ == "__main__":
    main()
