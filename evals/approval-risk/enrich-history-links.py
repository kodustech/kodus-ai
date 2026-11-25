#!/usr/bin/env python3
"""Add public linked bug-issue evidence to the sparse pre-snapshot history."""

import json
import re
import subprocess
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
HISTORY = ROOT / 'history-prs.json'
BUG_LABEL = re.compile(r'\b(?:bug|defect|regression)\b', re.I)


def query(repo, numbers):
    owner, name = repo.split('/', 1)
    fields = []
    for index, number in enumerate(numbers):
        fields.append(f'''p{index}:pullRequest(number:{number}){{
            closingIssuesReferences(first:20){{
                pageInfo{{hasNextPage}}
                nodes{{url labels(first:30){{pageInfo{{hasNextPage}} nodes{{name}}}}}}
            }}
        }}''')
    source = f'query{{repository(owner:"{owner}",name:"{name}"){{{" ".join(fields)}}}}}'
    for attempt in range(4):
        result = subprocess.run(
            ['gh', 'api', 'graphql', '-f', f'query={source}'],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            payload = json.loads(result.stdout)
            if not payload.get('errors'):
                return payload['data']['repository']
        if attempt == 3:
            raise RuntimeError((result.stderr or result.stdout)[:500])
        time.sleep(2 ** attempt)


def main():
    data = json.loads(HISTORY.read_text())
    rows = data['pullRequests']
    by_repo = defaultdict(list)
    for row in rows:
        by_repo[row['repository']].append(row)
    linked = unsupported = 0
    for repo, group in sorted(by_repo.items()):
        for start in range(0, len(group), 5):
            batch = group[start:start + 5]
            results = query(repo, [row['number'] for row in batch])
            for index, row in enumerate(batch):
                pr = results[f'p{index}']
                refs = pr['closingIssuesReferences']
                issues = refs['nodes']
                if refs['pageInfo']['hasNextPage'] or any(
                    issue['labels']['pageInfo']['hasNextPage'] for issue in issues
                ):
                    row['linkedBugIssues'] = None
                    unsupported += 1
                else:
                    row['linkedBugIssues'] = sorted(
                        issue['url'] for issue in issues
                        if any(BUG_LABEL.search(label['name']) for label in issue['labels']['nodes'])
                    )
                    linked += bool(row['linkedBugIssues'])
            print(f'{repo}: {min(start + len(batch), len(group))}/{len(group)}', flush=True)
    HISTORY.write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'historyPrs': len(rows), 'withLinkedBugIssues': linked, 'issueListingIncomplete': unsupported}))


if __name__ == '__main__':
    main()
