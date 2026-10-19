"""Junta ao verificacao-upstream.json a conferencia dos TPs novos do rodada snapi
(trabalho/upstream-prod/<caseId>/out.json); so entram os issueIds que sao TP no golden.json."""
import json, os, glob
T = os.path.dirname(os.path.abspath(__file__)); V3 = os.path.join(T, '..', '..')
V = json.load(open(f'{V3}/verificacao-upstream.json'))
g = {r['issueId']: r for l in json.load(open(f'{V3}/golden.json'))['prs'].values() for r in l if not r['subclass']}
inv = json.load(open(f'{V3}/trabalho/inventario.json'))
n = 0
for f in glob.glob(f'{T}/*/out.json'):
    o = json.load(open(f)); c = o['caseId']; i = json.load(open(os.path.join(os.path.dirname(f), 'in.json')))
    p = V['prs'].setdefault(c, {'prTitle': inv[c]['prTitle'], 'upstream': i['upstream'], 'prOriginal': o['prOriginal'], 'tps': {}})
    for k, t in o['tps'].items():
        if k in g:
            p['tps'][k] = {'bug': g[k]['comment'], 'severity': g[k]['severity'], **t}; n += 1
V['prs'] = dict(sorted(V['prs'].items()))
json.dump(V, open(f'{V3}/verificacao-upstream.json', 'w'), indent=1, ensure_ascii=False)
print('TPs adicionados', n, '| PRs', len(V['prs']), '| TPs', sum(len(p['tps']) for p in V['prs'].values()))
