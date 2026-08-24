#!/usr/bin/env python3
"""Split the investigation agent's stdout into the two contract files.

The agent runs strictly read-only (Write/Bash denied by policy — it reads
untrusted droplet logs, and a later step executes checkout code with a
token), so its whole output arrives on stdout: a markdown report ending
in one fenced ```json block. This trusted script materializes
investigation.md (report, without the JSON fence) and investigation.json
(the parsed block) for the summary/upsert steps.

Advisory: on any problem it prints a notice and exits 0 — the upsert
step already tolerates a missing/invalid investigation.json.

Usage: extract-investigation.py <raw-agent-output> [out-dir]
"""

import json
import re
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: extract-investigation.py <raw-agent-output> [out-dir]")
        return
    out_dir = (sys.argv[2] if len(sys.argv) > 2 else ".").rstrip("/")

    try:
        with open(sys.argv[1]) as fh:
            raw = fh.read()
    except OSError as exc:
        print("No agent output to extract ({}).".format(exc))
        return

    # The contract block is the LAST fenced json that parses as a list of
    # finding dicts. Item selection and report truncation are tied to the
    # SAME match: the narrative may contain other json fences (an echoed
    # schema example, quoted payloads), and cutting at a different fence
    # than the one parsed would ship a report inconsistent with the data.
    matches = list(re.finditer(r"```json\s*\n(.*?)```", raw, flags=re.DOTALL))
    items = None
    contract_start = None
    for match in reversed(matches):
        try:
            parsed = json.loads(match.group(1))
        except ValueError:
            continue
        if isinstance(parsed, list) and all(
            isinstance(x, dict) and "signature" in x for x in parsed
        ):
            items = parsed
            contract_start = match.start()
            break

    if items is None:
        print("::warning title=E2E investigation (advisory)::no parseable contract json block in agent output")
    else:
        with open(out_dir + "/investigation.json", "w") as fh:
            json.dump(items, fh, indent=1)
        print("Extracted {} finding(s) to investigation.json".format(len(items)))

    report = raw
    if contract_start is not None and contract_start > 0:
        report = raw[:contract_start].rstrip() + "\n"
    if report.strip():
        with open(out_dir + "/investigation.md", "w") as fh:
            fh.write(report)
        print("Wrote investigation.md ({} chars)".format(len(report)))
    else:
        print("::warning title=E2E investigation (advisory)::agent output was empty")


if __name__ == "__main__":
    main()
