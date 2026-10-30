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
    parser.add_argument('--full', type=Path)
    parser.add_argument('--retry', type=Path)
    parser.add_argument('--merged', type=Path, help='One merged 200-case result')
    parser.add_argument('--set', choices=('full', 'full-balanced'), default='full')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--blind-output', type=Path)
    parser.add_argument('--candidate-run', action='append', default=[], metavar='RUN_ID=JSON')
    parser.add_argument('--candidate-output', type=Path)
    args = parser.parse_args()
    if bool(args.merged) == bool(args.full):
        parser.error('provide --merged or --full with --retry')
    if args.full and not args.retry:
        parser.error('--full requires --retry')
    if args.merged and args.retry:
        parser.error('--retry is only valid with --full')
    if args.set == 'full-balanced' and not args.merged:
        parser.error('the balanced corpus requires --merged')
    if bool(args.candidate_run) != bool(args.candidate_output):
        parser.error('--candidate-run and --candidate-output must be used together')

    balanced = args.set == 'full-balanced'
    candidate_plan = json.loads((ROOT / ('balanced-selection.json' if balanced else 'adjudication-plan.json')).read_text())['ids']
    labels = {case['id']: case for case in json.loads((ROOT / ('adjudications-balanced.json' if balanced else 'adjudications.json')).read_text())['cases']}
    plan = candidate_plan if balanced else candidate_plan[:len(labels)]
    if set(plan) != set(labels):
        raise ValueError('the first scored cases do not match the frozen candidate plan')
    snapshots = {
        case['id']: case
        for case in json.load(gzip.open(ROOT / 'snapshots.json.gz'))['cases']
    }
    if args.merged:
        merged_result = json.loads(args.merged.read_text())
        if merged_result.get('set', 'full') != args.set:
            raise ValueError('merged result uses a different corpus')
        cases = measured_cases(args.merged)
        retry_cases = {}
    else:
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
            'evalRun': 'merged' if args.merged else ('39508066835' if ident in retry_cases else '39493931285'),
        })

    order = {'wrong_approval': 0, 'missed_approval': 1, 'agreement': 2}
    rows.sort(key=lambda row: (order[row['priority']], row['id']))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows({key: safe_cell(value) for key, value in row.items()} for row in rows)
    if args.candidate_output:
        candidate_cases = {}
        for entry in args.candidate_run:
            run_id, separator, path = entry.partition('=')
            if not separator or not run_id or not path:
                raise ValueError(f'expected RUN_ID=JSON, got {entry!r}')
            for ident, case in measured_cases(Path(path)).items():
                if ident in candidate_cases:
                    raise ValueError(f'duplicate candidate result: {ident}')
                candidate_cases[ident] = (run_id, case)
        if set(candidate_cases) != set(plan):
            missing = sorted(set(plan) - set(candidate_cases))
            extra = sorted(set(candidate_cases) - set(plan))
            raise ValueError(
                f'candidate results must measure the same 200 cases; '
                f'missing={missing}, extra={extra}'
            )
        comparison = []
        for row in rows:
            run_id, case = candidate_cases[row['id']]
            metadata = case['metadata']
            expected = 'hold' if row['codexLabel'] == 'hold' else 'approve'
            if metadata['expect'] != expected:
                raise ValueError(f'{row["id"]}: candidate expectation differs from frozen label')
            decision = metadata['arms']['modelAndMap']
            if expected == 'hold' and decision == 'approve':
                priority = 'wrong_approval'
            elif expected == 'approve' and decision == 'hold':
                priority = 'missed_approval'
            else:
                priority = 'agreement'
            comparison.append({
                'id': row['id'],
                'snapshotAt': row['snapshotAt'],
                'compareUrl': row['compareUrl'],
                'codexLabel': row['codexLabel'],
                'originalModelMapDecision': row['modelMapDecision'],
                'candidateModelOnlyDecision': metadata['arms']['modelOnly'],
                'candidateModelMapDecision': decision,
                'candidatePriority': priority,
                'candidateRisk': metadata['risks']['modelAndMap']['level'],
                'candidateReason': metadata['risks']['modelAndMap']['reason'],
                'sparseHistory': metadata['sparseHistory'],
                'linkedBugHistory': metadata['linkedBugHistory'],
                'candidateEvalRun': run_id,
            })
        comparison.sort(key=lambda row: (order[row['candidatePriority']], row['id']))
        args.candidate_output.parent.mkdir(parents=True, exist_ok=True)
        with args.candidate_output.open('w', newline='') as file:
            writer = csv.DictWriter(file, fieldnames=list(comparison[0]))
            writer.writeheader()
            writer.writerows({key: safe_cell(value) for key, value in row.items()} for row in comparison)
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
