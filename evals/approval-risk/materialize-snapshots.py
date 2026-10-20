#!/usr/bin/env python3
"""Reconstruct pre-review PR snapshots without copying outcome labels."""

import concurrent.futures
import gzip
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent


def gh(endpoint, selector="{status:.status,ahead_by:.ahead_by,files:[.files[]? | {filename,status,additions,deletions,patch}]}"):
    command = [
        "gh", "api", endpoint,
        "--jq", selector,
    ]
    for attempt in range(4):
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if attempt == 3:
            raise RuntimeError(result.stderr[:200])
        time.sleep(2 ** attempt)


def materialize(entry):
    candidate, source = entry
    commits = source.get("pr_commits") or []
    if not commits:
        raise ValueError("No PR commits in source")
    first = min(commits, key=lambda commit: commit.get("date") or commit.get("raw_date") or "9999")
    before_open = [commit for commit in commits if (commit.get("date") or commit.get("raw_date") or "9999") <= candidate["createdAt"]]
    selected = max(before_open, key=lambda commit: commit.get("date") or commit.get("raw_date")) if before_open else first
    sha = selected["sha"]
    base = candidate["baseSha"]
    repo = candidate["repository"]
    compare = gh(f"repos/{repo}/compare/{base}...{sha}?per_page=100")
    base_source = "recorded-base"
    if compare.get("status") != "ahead":
        commit = gh(f"repos/{repo}/commits/{first['sha']}", "{parents:[.parents[].sha]}")
        parents = commit.get("parents") or []
        if not parents:
            raise ValueError("First commit has no reconstructable parent")
        base = parents[0]
        base_source = "first-commit-parent"
        compare = gh(f"repos/{repo}/compare/{base}...{sha}?per_page=100")
    if compare.get("status") != "ahead" or compare.get("ahead_by", 0) < 1:
        raise ValueError(f"Base-to-head comparison is {compare.get('status')}")
    files = compare.get("files") or []
    if not files or len(files) >= 300:
        raise ValueError("Comparison has no files or may be truncated")
    descriptions = [item for item in source.get("pr_timeline", []) if item.get("type") == "description"]
    initial_body = min(descriptions, key=lambda item: item.get("created_at") or "9999").get("body", "") if descriptions else source.get("pr_statement", "")
    snapshot_at = max(candidate["createdAt"], selected.get("date") or selected.get("raw_date") or candidate["createdAt"])
    finding_times = [
        change.get("change_discussion", {}).get("first_mention_timestamp")
        for change in source.get("changes", [])
    ]
    finding_times = [value for value in finding_times if value]
    if finding_times and snapshot_at > min(finding_times):
        raise ValueError("Earliest commit was not reviewable before the recorded finding")
    snapshot = {
        "id": candidate["id"],
        "repository": repo,
        "repositoryId": repo,
        "prNumber": candidate["prNumber"],
        "prUrl": candidate["url"],
        "compareUrl": f"https://github.com/{repo}/compare/{base}...{sha}",
        "baseSha": base,
        "recordedBaseSha": candidate["baseSha"],
        "baseSource": base_source,
        "headSha": sha,
        "snapshotAt": snapshot_at,
        "title": source.get("pr_title", ""),
        "body": initial_body or "",
        "files": files,
        "filesComplete": True,
        "labels": [],
        "author": first.get("author", ""),
        "areaMap": None,
    }
    return snapshot


def main(source_path):
    candidates = json.loads((ROOT / "candidates.json").read_text())["cases"]
    ids = {row["id"]: row for row in candidates}
    entries = []
    for line in Path(source_path).open():
        row = json.loads(line)
        repo = row.get("repo")
        number = row.get("instance_id", "").rsplit("-", 1)[-1]
        candidate = ids.get(f"{repo}#{number}")
        if candidate:
            entries.append((candidate, row))
    if len(entries) != len(candidates):
        raise RuntimeError("The source file does not contain every candidate")
    snapshots, excluded = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(materialize, entry): entry[0] for entry in entries}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                snapshots.append(future.result())
            except Exception as error:
                excluded.append({"id": futures[future]["id"], "reason": str(error)})
            if index % 50 == 0:
                print(f"reconstructed {index}/{len(entries)}", flush=True)
    snapshots.sort(key=lambda row: row["id"])
    excluded.sort(key=lambda row: row["id"])
    with (ROOT / "snapshots.json.gz").open("wb") as target:
        with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as output:
            output.write(json.dumps({"schemaVersion": 1, "cases": snapshots}).encode())
    (ROOT / "excluded-snapshots.json").write_text(json.dumps(excluded, indent=2) + "\n")
    print(json.dumps({"snapshots": len(snapshots), "excluded": len(excluded)}), flush=True)
    return 0 if len(snapshots) >= 200 else 2


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: materialize-snapshots.py /path/to/swr_datasets_d5c5.jsonl", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
