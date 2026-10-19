"""Entrada da conferencia upstream para os TPs novos do rodada snapi (Sonnet SDK pela API).
  python3 monta.py <issueId> [<issueId> ...]   (classe final TP vinda de snapi)"""
import json, sys, os, glob
T = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = f'{T}/snapi'
oc = {}; [oc.update(json.load(open(f))) for f in glob.glob(f'{P}/opus-classif-*.json')]
ac = {x['issueId']: x for f in glob.glob(f'{P}/astra-classif/*.json') for x in json.load(open(f))['items']}
IN = json.load(open(f'{P}/classif-in.json'))
up = json.load(open(f'{T}/../verificacao-upstream.json'))['prs']
old = {c: json.load(open(f'{T}/upstream/{c}/in.json')) for c in os.listdir(f'{T}/upstream') if os.path.isdir(f'{T}/upstream/{c}')}
por = {}
for k in sys.argv[1:]:
    c = k.split('#')[0]
    por.setdefault(c, []).append(k)
for c, ks in por.items():
    base = old.get(c)
    d = {'caseId': c, 'prTitle': IN[c]['prTitle'], 'upstream': base['upstream'] if base else None, 'cloneLocal': IN[c]['repo'], 'base': IN[c]['base'], 'head': IN[c]['head'],
         'prOriginalConhecido': up[c]['prOriginal'] if c in up else None,
         'tps': [{'issueId': k, 'severity': oc[k]['severity'], 'category': oc[k]['category'], 'bug': oc[k]['comment'],
                  'evidenciaOpus': oc[k]['reason'], 'evidenciaAstra': ac[k]['reason']} for k in ks]}
    os.makedirs(f'{T}/upstream-snapi/{c}', exist_ok=True)
    json.dump(d, open(f'{T}/upstream-snapi/{c}/in.json', 'w'), indent=1, ensure_ascii=False)
    print(c, len(ks), d['upstream'], (d['prOriginalConhecido'] or {}).get('numero'))
