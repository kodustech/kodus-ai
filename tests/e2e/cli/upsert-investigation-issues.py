#!/usr/bin/env python3
"""Upsert GitHub issues from an agent-produced investigation.json.

One issue per stable failure signature: the first occurrence opens an
issue labeled `e2e-investigation` with the analysis; a recurrence adds a
comment ("seen again in run X") to the same issue — and reopens it if it
was closed. Matching is done by a `Signature: `e2e-sig:<key>`` line in
the issue body, resolved by listing labeled issues and matching locally
(GitHub search does not reliably index markers).

Advisory by design: any error prints a notice and exits 0.

Env: GH_TOKEN (issues: write), GITHUB_REPOSITORY, RUN_URL.
Usage: upsert-investigation-issues.py [investigation.json]
"""

import json
import os
import re
import subprocess
import sys

LABEL = "e2e-investigation"


def gh(*args, input_text=None):
    result = subprocess.run(
        ["gh", *args], capture_output=True, text=True, input=input_text,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError("gh {} failed: {}".format(args[0], result.stderr.strip()[:300]))
    return result.stdout


def slug_ok(signature):
    return bool(re.fullmatch(r"[A-Za-z0-9._\-:]{4,120}", signature or ""))


def issue_body(item, run_url):
    return (
        "Signature: `e2e-sig:{sig}`\n\n"
        "Automated investigation from the E2E matrix (agent analysis — verify before acting).\n\n"
        "- **Scenario**: `{scenario}` × `{cell}`\n"
        "- **Classification**: {cls} (confidence: {conf})\n\n"
        "### Root cause\n{root}\n\n"
        "### Suggested fix\n{fix}\n\n"
        "First seen: {run}\n"
    ).format(
        sig=item["signature"], scenario=item.get("scenario", "?"),
        cell=item.get("cell", "?"), cls=item.get("classification", "?"),
        conf=item.get("confidence", "?"), root=item.get("root_cause", "?"),
        fix=item.get("suggested_fix", "?"), run=run_url,
    )


def recurrence_comment(item, run_url):
    return (
        "Recurred in {run}.\n\n"
        "- **Classification**: {cls} (confidence: {conf})\n"
        "- **Root cause (this run's analysis)**: {root}\n"
    ).format(
        run=run_url, cls=item.get("classification", "?"),
        conf=item.get("confidence", "?"), root=item.get("root_cause", "?"),
    )


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "investigation.json"
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_url = os.environ.get("RUN_URL", "(run url unavailable)")
    if not repo:
        print("GITHUB_REPOSITORY not set — skipping issue upsert.")
        return

    try:
        with open(path) as fh:
            items = json.load(fh)
        assert isinstance(items, list)
    except Exception as exc:
        print("No usable {} — skipping issue upsert ({}).".format(path, exc))
        return

    try:
        gh("label", "create", LABEL, "--repo", repo, "--force",
           "--description", "Automated E2E failure investigation",
           "--color", "D93F0B")

        # gh paginates internally up to --limit; 1000 keeps reconciliation
        # exact until the label accumulates that many issues. If we ever hit
        # the cap, say so instead of silently duplicating.
        existing = json.loads(gh(
            "issue", "list", "--repo", repo, "--label", LABEL,
            "--state", "all", "--limit", "1000",
            "--json", "number,body,state",
        ))
        if len(existing) >= 1000:
            print("::warning title=investigation issue upsert::{} label has ≥1000 issues — "
                  "reconciliation may miss older ones (consider pruning closed issues)".format(LABEL))
    except Exception as exc:
        print("::warning title=investigation issue upsert failed (advisory)::{}".format(exc))
        return

    by_signature = {}
    for issue in existing:
        match = re.search(r"e2e-sig:([A-Za-z0-9._\-:]+)", issue.get("body") or "")
        if match:
            by_signature.setdefault(match.group(1), issue)

    # The agent may report the same failure once per cell (e.g. one quota
    # error across 4 providers) — same signature, one issue, one action.
    seen_this_run = set()
    for item in items:
        sig = item.get("signature", "")
        if not slug_ok(sig):
            print("Skipping item with unusable signature: {!r}".format(sig[:80]))
            continue
        if sig in seen_this_run:
            continue
        seen_this_run.add(sig)
        try:
            found = by_signature.get(sig)
            if found:
                number = str(found["number"])
                if found.get("state", "").lower() == "closed":
                    gh("issue", "reopen", number, "--repo", repo)
                gh("issue", "comment", number, "--repo", repo,
                   "--body-file", "-", input_text=recurrence_comment(item, run_url))
                print("Updated issue #{} for {}".format(number, sig))
            else:
                out = gh("issue", "create", "--repo", repo,
                         "--title", item.get("title", "E2E failure: " + sig)[:200],
                         "--label", LABEL,
                         "--body-file", "-", input_text=issue_body(item, run_url))
                print("Created {} for {}".format(out.strip(), sig))
        except Exception as exc:
            print("::warning title=investigation issue upsert failed (advisory)::{}: {}".format(sig, exc))


if __name__ == "__main__":
    main()
