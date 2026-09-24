#!/usr/bin/env python3
"""Junta os 23 PRs intactos com os 6 rerodados, em cada artefato."""
import json, sys
SEIS={'frontend-asset-optimization-grafana-codex','notification-rule-processing-engine-grafana-codex',
 'fix-concurrent-group-access-to-prevent-nullpointerexception-keycloak','anonymous-add-configurable-device-limit-grafana-codex',
 'add-client-resource-type-and-scopes-to-authorization-schema-keycloak','github-oauth-security-enhancement-sentry'}
def junta(velho, novo, saida, chave='saida'):
    a=json.load(open(f'results/{velho}')); b=json.load(open(f'results/{novo}'))
    if chave and chave in a:
        va,vb=a[chave],b[chave]
        out={k:v for k,v in va.items() if k not in SEIS}
        out.update({k:v for k,v in vb.items() if k in SEIS})
        a[chave]=out
        json.dump(a, open(f'results/{saida}','w'), indent=1)
        print(f'{saida}: {len(out)} PRs ({sum(1 for k in out if k in SEIS)} rerodados)')
    else:
        out={k:v for k,v in a.items() if k not in SEIS}
        out.update({k:v for k,v in b.items() if k in SEIS})
        json.dump(out, open(f'results/{saida}','w'), indent=1)
        print(f'{saida}: {len(out)} PRs ({sum(1 for k in out if k in SEIS)} rerodados)')
junta('rep-seletor.json','seletor-fix6.json','fix-seletor.json')
junta('rep-score2.json','score2-fix6.json','fix-score2.json')
# matriz: os 23 antigos vem das duas matrizes originais
a={}
for f in ['matriz-pre-teto2-30.json','matriz-pre-teto2-grandes.json']:
    a.update(json.load(open(f'results/{f}')))
b=json.load(open('results/matriz-fix6.json'))
out={k:v for k,v in a.items() if k not in SEIS}
out.update({k:v for k,v in b.items() if k in SEIS})
json.dump(out, open('results/matriz-fix.json','w'), indent=1)
print(f'matriz-fix.json: {len(out)} PRs ({sum(1 for k in out if k in SEIS)} rerodados)')
