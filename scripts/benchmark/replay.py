#!/usr/bin/env python3
"""
Offline replay rig — Tier 1 deterministic hypothesis testing.

Loads a FROZEN candidate corpus from a processed run (pool completo +
veredito do juiz) and lets you replay downstream rules (severity cap,
safeguard, dedup, judge method) WITHOUT re-running the agent.

Zero noise, deterministic. Same corpus + same rule -> same metrics.

Use it for any change DOWNSTREAM of the finder (verify/safeguard/severity/
cap/judge). Finder changes still need online replicated runs (Tier 2).

Corpus per candidate:
  pr_idx, ci, comment, finder_severity, location, priority_status,
  matched (bool), matched_gi (list), golden_severity (of best match)
Per PR: golden severities.

Usage:
  python3 replay.py <run-name> [--rule <name>]
  python3 replay.py <run-name> --compare        # all rules side by side
"""
import json, os, sys, argparse
from collections import defaultdict

RESULTS = os.path.join(os.path.dirname(__file__), 'results')


def load_corpus(run):
    """Load frozen corpus: candidates with finder attrs + judged golden matches."""
    base = os.path.join(RESULTS, run)
    ca = json.load(open(os.path.join(base, 'candidates-all.json')))
    mm = json.load(open(os.path.join(RESULTS, f'{run}-funnel', 'match-matrix.json')))
    gold = json.load(open(os.path.join(base, 'golden.json')))
    assert len(ca) == len(mm) == len(gold), (len(ca), len(mm), len(gold))

    prs = []
    for pi, pr in enumerate(ca):
        gcs = gold[pi]['golden_comments']
        if isinstance(gcs, str):
            gcs = json.loads(gcs)
        golden_sev = [(c.get('severity') or 'unknown').lower() for c in gcs]

        # best match per candidate (ci) and per golden (gi), with confidence
        match_by_ci = defaultdict(list)   # ci -> [(gi, conf)]
        for m in mm[pi]:
            if m.get('match'):
                match_by_ci[m['ci']].append((m['gi'], m.get('confidence', 0)))

        cands = []
        for ci, it in enumerate(pr['issues']):
            matches = sorted(match_by_ci.get(ci, []), key=lambda x: -x[1])
            best_gi = matches[0][0] if matches else None
            cands.append({
                'pr': pi, 'ci': ci,
                'comment': it.get('comment', ''),
                'finder_severity': (it.get('severity') or 'unknown').lower(),
                'location': it.get('location', ''),
                'priority_status': it.get('priorityStatus', 'prioritized'),
                'matched_gi': [g for g, _ in matches],
                'best_gi': best_gi,
                'best_conf': matches[0][1] if matches else 0,
            })
        prs.append({'pr': pi, 'repo': pr.get('repo'), 'goldens': len(gcs),
                    'golden_sev': golden_sev, 'cands': cands})
    return prs


def evaluate(prs, deliver_fn, match_mode='greedy'):
    """Apply deliver_fn(candidate, pr) -> bool, compute TP/FP/FN/P/R/F1.

    match_mode: 'greedy' (nosso 1:1) or 'reuse' (deles N:1).
    Golden severity available via candidate after a rule rewrites it.
    """
    TP = FP = FN = 0
    tp_by_sev = defaultdict(int); tot_by_sev = defaultdict(int)
    for pr in prs:
        delivered = [c for c in pr['cands'] if deliver_fn(c, pr)]
        # golden totals by severity
        for s in pr['golden_sev']:
            tot_by_sev[s] += 1
        if match_mode == 'greedy':
            # each candidate consumes at most one golden, by confidence desc
            pos = sorted([c for c in delivered if c['best_gi'] is not None],
                         key=lambda c: -c['best_conf'])
            gm = set(); cm = set()
            for c in pos:
                if c['best_gi'] in gm or c['ci'] in cm:
                    # try other matched goldens of this candidate
                    alt = next((g for g in c['matched_gi'] if g not in gm), None)
                    if alt is None or c['ci'] in cm:
                        continue
                    gm.add(alt); cm.add(c['ci']); tp_by_sev[pr['golden_sev'][alt]] += 1
                else:
                    gm.add(c['best_gi']); cm.add(c['ci'])
                    tp_by_sev[pr['golden_sev'][c['best_gi']]] += 1
            tp = len(gm)
            fp = len(delivered) - len(cm)
        else:  # reuse: each golden matched by best delivered candidate; cand reusable
            gm = set(); matched_c = set()
            for c in delivered:
                for g in c['matched_gi']:
                    gm.add(g); matched_c.add(c['ci'])
            for g in gm:
                tp_by_sev[pr['golden_sev'][g]] += 1
            tp = len(gm)
            fp = len(delivered) - len(matched_c)
        fn = pr['goldens'] - tp
        TP += tp; FP += fp; FN += fn
    p = TP/(TP+FP) if TP+FP else 0
    r = TP/(TP+FN) if TP+FN else 0
    f1 = 2*p*r/(p+r) if p+r else 0
    return {'TP': TP, 'FP': FP, 'FN': FN, 'P': round(p, 3), 'R': round(r, 3),
            'F1': round(f1, 3), 'tp_by_sev': dict(tp_by_sev), 'tot_by_sev': dict(tot_by_sev)}


# ----- RULES (deliver predicates) -----
# Each rule may mutate candidate severity in place before deciding delivery.

def rule_baseline(c, pr):
    """Current production: only 'prioritized' is delivered."""
    return c['priority_status'] == 'prioritized'

def rule_no_severity_cap(c, pr):
    """Recover candidates killed only by the severity cap."""
    return c['priority_status'] in ('prioritized', 'discarded-by-severity')

def rule_no_safeguard(c, pr):
    """Recover candidates killed by safeguard verify."""
    return c['priority_status'] in ('prioritized', 'discarded-by-safeguard')

def rule_no_downstream(c, pr):
    """Pool completo pós-finder: nada é descartado downstream (teto do finder)."""
    return True

RULES = {
    'baseline': rule_baseline,
    'no-severity-cap': rule_no_severity_cap,
    'no-safeguard': rule_no_safeguard,
    'finder-ceiling': rule_no_downstream,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run')
    ap.add_argument('--rule', default=None)
    ap.add_argument('--match', default='greedy', choices=['greedy', 'reuse'])
    ap.add_argument('--compare', action='store_true')
    args = ap.parse_args()

    prs = load_corpus(args.run)
    ncand = sum(len(p['cands']) for p in prs)
    ngold = sum(p['goldens'] for p in prs)
    print(f"corpus {args.run}: {len(prs)} PRs, {ncand} candidatos, {ngold} goldens, match={args.match}\n")

    rules = RULES if (args.compare or not args.rule) else {args.rule: RULES[args.rule]}
    print(f"{'regra':18}{'TP':>5}{'FP':>5}{'FN':>5}{'P':>7}{'R':>7}{'F1':>7}")
    for name, fn in rules.items():
        m = evaluate(prs, fn, args.match)
        print(f"{name:18}{m['TP']:>5}{m['FP']:>5}{m['FN']:>5}{m['P']:>7.3f}{m['R']:>7.3f}{m['F1']:>7.3f}")


if __name__ == '__main__':
    main()
