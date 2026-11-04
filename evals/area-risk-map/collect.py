#!/usr/bin/env python3
"""Collect a frozen, public temporal corpus for the code-area map eval."""

import concurrent.futures
import datetime as dt
import json
import re
import subprocess
import sys
import time
from pathlib import Path

DEVELOPMENT_REPOS = {
    "astropy/astropy": 90,
    "ansible/ansible": 90,
    "pandas-dev/pandas": 27,
    "fastapi/fastapi": 7,
    "pydata/xarray": 2,
    "scikit-learn/scikit-learn": 4,
}
HOLDOUT_REPOS = {
    "astropy/astropy": 60,
    "ansible/ansible": 60,
    "pandas-dev/pandas": 57,
    "fastapi/fastapi": 36,
}
HOLDOUT_2026_REPOS = {
    "pandas-dev/pandas": 200,
    "astropy/astropy": 250,
    "ansible/ansible": 200,
    "fastapi/fastapi": 20,
}
HOLDOUT_2026_EXTENSION = {
    "pandas-dev/pandas": 40,
    "astropy/astropy": 25,
    "ansible/ansible": 15,
}
ROOT = Path(__file__).parent
HISTORY_PER_REPO = 100
BUG_LABEL = re.compile(r"\b(?:bug|defect|regression)\b", re.I)
REFERENCE = re.compile(r"\b(?:fix(?:es)?|clos(?:e|es)|resolv(?:e|es))\s+#(\d+)\b", re.I)


def gh(endpoint, fields=None):
    command = ["gh", "api", "-X", "GET", endpoint]
    for key, value in (fields or {}).items():
        command += ["-f", f"{key}={value}"]
    for attempt in range(4):
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if attempt == 3:
            raise RuntimeError(f"GitHub request failed for {endpoint}: {result.stderr[:200]}")
        time.sleep(2 ** attempt)


def search(repo, query, max_pages=10):
    rows = []
    for page in range(1, max_pages + 1):
        result = gh("search/issues", {
            "q": f"repo:{repo} is:pr is:merged {query}",
            "per_page": 100,
            "page": page,
            "sort": "created",
            "order": "desc",
        })
        batch = result.get("items", [])
        rows += batch
        if len(batch) < 100:
            break
    return rows


def evenly_spaced(rows, count):
    if len(rows) <= count:
        return rows
    return [rows[round(index * (len(rows) - 1) / (count - 1))] for index in range(count)]


def enrich(entry):
    repo, role, issue = entry
    number = issue["number"]
    files = gh(f"repos/{repo}/pulls/{number}/files", {"per_page": 100})
    if not isinstance(files, list):
        raise RuntimeError(f"Unexpected file response for {repo}#{number}")
    paths = [row["filename"] for row in files if row.get("filename")]
    result = {
        "id": f"{repo}#{number}",
        "repository": repo,
        "number": number,
        "url": issue["html_url"],
        "title": issue["title"],
        "mergedAt": issue["closed_at"],
        "files": paths,
        "filesComplete": len(files) < 100,
    }
    if role == "history":
        refs = list(dict.fromkeys(int(n) for n in REFERENCE.findall(issue.get("body") or "")))[:5]
        linked = []
        for ref in refs:
            linked_issue = gh(f"repos/{repo}/issues/{ref}")
            if linked_issue.get("pull_request"):
                continue
            labels = [item["name"] if isinstance(item, dict) else item for item in linked_issue.get("labels", [])]
            if any(BUG_LABEL.search(label) for label in labels):
                linked.append(linked_issue["html_url"])
        result["linkedBugIssues"] = linked
    return role, result


def main():
    holdout_2026 = "--holdout-2026" in sys.argv
    holdout = "--holdout" in sys.argv
    repos = HOLDOUT_2026_REPOS if holdout_2026 else HOLDOUT_REPOS if holdout else DEVELOPMENT_REPOS
    history_start = "2025-07-01" if holdout_2026 else "2025-01-01" if holdout else "2024-10-01"
    history_end = "2025-12-31" if holdout_2026 else "2025-06-30" if holdout else "2024-12-31"
    target_start = "2026-01-01" if holdout_2026 else "2025-07-01" if holdout else "2025-01-01"
    target_end = "2026-06-30" if holdout_2026 else "2025-12-31" if holdout else "2025-06-30"
    output_name = "cases-holdout-2026.json" if holdout_2026 else "cases-holdout.json" if holdout else "cases.json"
    output_path = ROOT / output_name
    cached = json.loads(output_path.read_text()) if holdout_2026 and output_path.exists() else None
    cached_by_id = {
        row["id"]: row
        for role in ("targets", "history")
        for row in (cached or {}).get(role, [])
    }
    tasks = []
    selection = {}
    reused = {"targets": [], "history": []}
    for repo, target_limit in repos.items():
        targets = search(repo, f"label:bug merged:{target_start}..{target_end}")[:target_limit]
        if holdout_2026 and repo in HOLDOUT_2026_EXTENSION:
            targets += search(repo, "label:bug merged:2026-07-01..2026-09-30")[:HOLDOUT_2026_EXTENSION[repo]]
        histories = evenly_spaced(
            search(repo, f"merged:{history_start}..{history_end}"), HISTORY_PER_REPO
        )
        selection[repo] = {"targets": len(targets), "history": len(histories)}
        for role, rows in (("target", targets), ("history", histories)):
            for row in rows:
                key = f"{repo}#{row['number']}"
                if key in cached_by_id:
                    reused["targets" if role == "target" else "history"].append(cached_by_id[key])
                else:
                    tasks.append((repo, role, row))
    print(json.dumps({"selected": selection, "requests": len(tasks)}), flush=True)

    output = {"schemaVersion": 1, "source": "GitHub Search and pull files API", "historyWindow": [f"{history_start}T00:00:00Z", f"{target_start}T00:00:00Z"], "targetWindowEnd": "2026-09-30T23:59:59Z" if holdout_2026 else f"{target_end}T23:59:59Z", "targets": reused["targets"], "history": reused["history"], "errors": []}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(enrich, task): task for task in tasks}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                role, result = future.result()
                output[role if role == "history" else "targets"].append(result)
            except Exception as error:
                repo, role, issue = futures[future]
                output["errors"].append({"id": f"{repo}#{issue['number']}", "error": str(error)})
            if index % 50 == 0:
                print(f"collected {index}/{len(tasks)}", flush=True)
    output["collectedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    for key in ("targets", "history"):
        output[key].sort(key=lambda row: row["id"])
    output_path.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({key: len(output[key]) for key in ("targets", "history", "errors")}), flush=True)
    return 0 if len(output["targets"]) >= 200 else 2


if __name__ == "__main__":
    sys.exit(main())
