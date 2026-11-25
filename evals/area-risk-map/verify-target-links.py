#!/usr/bin/env python3
"""Verify held-out bugfix targets against linked bug-labeled issues."""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
BUG = re.compile(r"\b(?:bug|defect|regression)\b", re.I)


def linked(repo, numbers):
    owner, name = repo.split('/', 1)
    fields = ' '.join(
        f'p{i}:pullRequest(number:{number}){{closingIssuesReferences(first:10){{nodes{{url labels(first:20){{nodes{{name}}}}}}}}}}'
        for i, number in enumerate(numbers)
    )
    query = f'query{{repository(owner:"{owner}",name:"{name}"){{{fields}}}}}'
    result = subprocess.run(['gh', 'api', 'graphql', '-f', f'query={query}'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[:250])
    data = json.loads(result.stdout)
    if data.get('errors'):
        raise RuntimeError(str(data['errors'])[:250])
    repository = data['data']['repository']
    urls = {}
    for i, number in enumerate(numbers):
        nodes = (repository.get(f'p{i}') or {}).get('closingIssuesReferences', {}).get('nodes', [])
        urls[number] = [
            issue['url'] for issue in nodes
            if any(BUG.search(label['name']) for label in issue['labels']['nodes'])
        ]
    return urls


def main(file):
    path = ROOT / file
    data = json.loads(path.read_text())
    counts = {}
    for repo in sorted({row['repository'] for row in data['targets']}):
        targets = [row for row in data['targets'] if row['repository'] == repo]
        urls = {}
        for start in range(0, len(targets), 20):
            urls.update(linked(repo, [row['number'] for row in targets[start:start + 20]]))
        for row in targets:
            row['linkedBugIssues'] = urls[row['number']]
        counts[repo] = sum(bool(row['linkedBugIssues']) for row in targets)
    path.write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps(counts))
    print(f"verified {sum(counts.values())}/{len(data['targets'])} target bugfix links")


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in ('cases.json', 'cases-holdout.json', 'cases-holdout-2026.json'):
        print('Usage: verify-target-links.py cases[-holdout[-2026]].json', file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
