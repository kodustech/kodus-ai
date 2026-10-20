#!/usr/bin/env python3
"""Export a reviewable CSV from the full approval eval and its failed-case retry."""

import argparse
import csv
import gzip
import json
import random
from pathlib import Path

ROOT = Path(__file__).parent


def safe_cell(value):
    text = str(value if value is not None else '')
    return "'" + text if text.lstrip().startswith(('=', '+', '-', '@')) else text


def measured_cases(path):
    result = json.loads(path.read_text())
    if result['eval'] != 'approval-risk':
        raise ValueError(f'{path}: unexpected eval')
    return {case['id']: case for case in result['cases'] if not case.get('unmeasured')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--full', type=Path, required=True)
    parser.add_argument('--retry', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--blind-output', type=Path)
    args = parser.parse_args()

    candidate_plan = json.loads((ROOT / 'adjudication-plan.json').read_text())['ids']
    labels = {case['id']: case for case in json.loads((ROOT / 'adjudications.json').read_text())['cases']}
    plan = candidate_plan[:len(labels)]
    if set(plan) != set(labels):
        raise ValueError('the first scored cases do not match the frozen candidate plan')
    snapshots = {
        case['id']: case
        for case in json.load(gzip.open(ROOT / 'snapshots.json.gz'))['cases']
    }
    full_cases = measured_cases(args.full)
    retry_cases = measured_cases(args.retry)
    missing = set(plan) - set(full_cases)
    if set(retry_cases) != missing:
        raise ValueError(f'retry IDs {sorted(retry_cases)} differ from missing IDs {sorted(missing)}')
    cases = full_cases | retry_cases
    if len(plan) != 200 or len(set(plan)) != 200 or set(cases) != set(plan):
        raise ValueError('expected exactly 200 distinct measured cases from the frozen plan')

    rows = []
    for ident in plan:
        case = cases[ident]
        label = labels[ident]
        snapshot = snapshots[ident]
        metadata = case['metadata']
        arms = metadata['arms']
        expected = 'hold' if label['decision'] == 'hold' else 'approve'
        if label['decision'] not in ('hold', 'eligible') or metadata['expect'] != expected:
            raise ValueError(f'{ident}: adjudication differs from eval expectation')
        if label['snapshotSha'] != snapshot['headSha']:
            raise ValueError(f'{ident}: adjudication differs from snapshot SHA')
        observed = arms['modelAndMap']
        priority = (
            'wrong_approval' if expected == 'hold' and observed == 'approve'
            else 'missed_approval' if expected == 'approve' and observed == 'hold'
            else 'agreement'
        )
        rows.append({
            'priority': priority,
            'id': ident,
            'snapshotAt': snapshot['snapshotAt'],
            'compareUrl': snapshot['compareUrl'],
            'codexLabel': label['decision'],
            'codexRationale': label['rationale'],
            'baselineDecision': arms['baseline'],
            'modelOnlyDecision': arms['modelOnly'],
            'modelMapDecision': observed,
            'modelMapRisk': metadata['risks']['modelAndMap']['level'],
            'modelMapReason': metadata['risks']['modelAndMap']['reason'],
            'sparseHistory': metadata['sparseHistory'],
            'linkedBugHistory': metadata['linkedBugHistory'],
            'evalRun': '39508066835' if ident in retry_cases else '39493931285',
        })

    order = {'wrong_approval': 0, 'missed_approval': 1, 'agreement': 2}
    rows.sort(key=lambda row: (order[row['priority']], row['id']))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows({key: safe_cell(value) for key, value in row.items()} for row in rows)
    if args.blind_output:
        blind_ids = plan.copy()
        random.Random(1765).shuffle(blind_ids)
        args.blind_output.parent.mkdir(parents=True, exist_ok=True)
        with args.blind_output.open('w', newline='') as file:
            writer = csv.writer(file)
            writer.writerow((
                'caseId', 'snapshotAt', 'compareUrl', 'fileCount',
                'filesComplete', 'humanLabel', 'humanRationale',
            ))
            for ident in blind_ids:
                snapshot = snapshots[ident]
                writer.writerow((
                    safe_cell(ident),
                    snapshot['snapshotAt'],
                    snapshot['compareUrl'],
                    len(snapshot['files']),
                    snapshot['filesComplete'],
                    '',
                    '',
                ))
    print(f'{len(rows)} cases exported; {sum(row["priority"] == "wrong_approval" for row in rows)} wrong approvals')


if __name__ == '__main__':
    main()
