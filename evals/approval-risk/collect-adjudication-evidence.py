#!/usr/bin/env python3
"""Fetch later public review evidence for the fixed adjudication plan.

This data stays outside the scored snapshots so it cannot enter the model input.
"""

import gzip
import json
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).parent
OUTPUT = Path('/private/tmp' if Path('/private/tmp').is_dir() else tempfile.gettempdir()) / 'approval-adjudication-evidence.json.gz'
PLAN = json.loads((ROOT / 'adjudication-plan.json').read_text())['ids']


def graphql(source):
    for attempt in range(4):
        result = subprocess.run(
            ['gh', 'api', 'graphql', '-f', f'query={source}'],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if not data.get('errors'):
                return data['data']
        if attempt == 3:
            raise RuntimeError((result.stderr or result.stdout)[:500])
        time.sleep(2 ** attempt)


def query(repo, numbers):
    owner, name = repo.split('/', 1)
    fields = []
    for index, number in enumerate(numbers):
        fields.append(f'''p{index}:pullRequest(number:{number}){{
            url mergedAt closedAt state changedFiles additions deletions
            reviews(first:50){{pageInfo{{hasNextPage}} nodes{{url bodyText state submittedAt author{{login}}}}}}
            comments(first:50){{pageInfo{{hasNextPage}} nodes{{url bodyText createdAt author{{login}}}}}}
            reviewThreads(first:50){{pageInfo{{hasNextPage}} nodes{{id comments(first:5){{pageInfo{{hasNextPage endCursor}} nodes{{url bodyText path createdAt author{{login}}}}}}}}}}
            commits(first:50){{pageInfo{{hasNextPage}} nodes{{commit{{oid committedDate messageHeadline}}}}}}
        }}''')
    source = f'query{{repository(owner:"{owner}",name:"{name}"){{{" ".join(fields)}}}}}'
    return graphql(source)['repository']


def incomplete(pr):
    if pr is None:
        return False
    return any(pr[key]['pageInfo']['hasNextPage'] for key in ('reviews', 'comments', 'reviewThreads', 'commits')) or any(
        thread['comments']['pageInfo']['hasNextPage'] for thread in pr['reviewThreads']['nodes']
    )


def complete_threads(pr):
    if pr is None:
        return
    for key in ('reviews', 'comments', 'reviewThreads', 'commits'):
        if pr[key]['pageInfo']['hasNextPage']:
            raise RuntimeError(f'{key} has more than 50 entries; pagination required before adjudication')
    for thread in pr['reviewThreads']['nodes']:
        connection = thread['comments']
        while connection['pageInfo']['hasNextPage']:
            cursor = connection['pageInfo']['endCursor']
            if not thread.get('id') or not cursor:
                raise RuntimeError('Incomplete thread lacks a pagination cursor')
            source = (
                'query { node(id: ' + json.dumps(thread['id']) + ') {'
                ' ... on PullRequestReviewThread { comments(first: 100, after: '
                + json.dumps(cursor) + ') {'
                ' pageInfo { hasNextPage endCursor }'
                ' nodes { url bodyText path createdAt author { login } }'
                ' } } } }'
            )
            page = graphql(source)['node']['comments']
            connection['nodes'].extend(page['nodes'])
            connection['pageInfo'] = page['pageInfo']


def save(data):
    OUTPUT.write_bytes(gzip.compress(json.dumps(data).encode(), mtime=0))


def main():
    previous = json.loads(gzip.decompress(OUTPUT.read_bytes())) if OUTPUT.exists() else {}
    by_repo = {}
    for ident in PLAN:
        repo, number = ident.rsplit('#', 1)
        if ident not in previous or incomplete(previous[ident]):
            by_repo.setdefault(repo, []).append(int(number))
    remaining = sum(map(len, by_repo.values()))
    print(f'completed={len(previous)} remaining={remaining}', flush=True)
    for repo, numbers in sorted(by_repo.items()):
        for offset in range(0, len(numbers), 5):
            batch = numbers[offset:offset + 5]
            result = query(repo, batch)
            for index, number in enumerate(batch):
                pr = result[f'p{index}']
                complete_threads(pr)
                previous[f'{repo}#{number}'] = pr
            save(previous)
            print(f'{repo}: {min(offset + len(batch), len(numbers))}/{len(numbers)}', flush=True)
    print(f'collected={len(previous)}', flush=True)


if __name__ == '__main__':
    main()
