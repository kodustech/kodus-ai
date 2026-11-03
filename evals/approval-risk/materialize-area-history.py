#!/usr/bin/env python3
"""Collect the merged, pre-snapshot subset of the approval corpus as map input."""

import concurrent.futures
import gzip
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent


def gh(endpoint):
    for attempt in range(4):
        result = subprocess.run(['gh', 'api', '-X', 'GET', endpoint], capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if attempt == 3:
            raise RuntimeError(result.stderr[:200])
        time.sleep(2 ** attempt)


def fetch(snapshot):
    repo, number = snapshot['repository'], snapshot['prNumber']
    pr = gh(f'repos/{repo}/pulls/{number}')
    if not pr.get('merged_at'):
        return None
    files = gh(f'repos/{repo}/pulls/{number}/files?per_page=100')
    return {
        'id': snapshot['id'],
        'repository': repo,
        'number': number,
        'url': pr['html_url'],
        'title': pr['title'],
        'mergedAt': pr['merged_at'],
        'files': [row['filename'] for row in files if row.get('filename')],
        'filesComplete': len(files) < 100,
        'linkedBugIssues': [],
    }


def main():
    with gzip.open(ROOT / 'snapshots.json.gz', 'rt') as source:
        snapshots = json.load(source)['cases']
    rows, errors = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch, row): row['id'] for row in snapshots}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                result = future.result()
                if result:
                    rows.append(result)
            except Exception as error:
                errors.append({'id': futures[future], 'error': str(error)})
            if index % 50 == 0:
                print(f'history fetched {index}/{len(snapshots)}', flush=True)
    rows.sort(key=lambda row: row['id'])
    (ROOT / 'history-prs.json').write_text(json.dumps({'schemaVersion': 1, 'pullRequests': rows, 'errors': errors}, indent=2) + '\n')
    print(json.dumps({'merged': len(rows), 'errors': len(errors)}), flush=True)
    return 0 if not errors else 2


if __name__ == '__main__':
    sys.exit(main())
