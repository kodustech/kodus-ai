"""Ancora comentavel (#1821): o que o parseFinderSchema de producao exige (arquivo, linha inicial e final, texto;
libs/code-review/infrastructure/agents/engine/parse-finder-schema.ts) e o arquivo estar entre os arquivos do PR.
Sugestao que falha nao vira comentario, entao nao conta no placar: nem como TP, nem como comentario."""
import json, os, glob
_INV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'investigation', 'datasets')
_FILES = {}
for _f in glob.glob(f'{_INV}/*.json'):
    _d = json.load(open(_f))
    for _row in (_d if isinstance(_d, list) else [_d]):
        _v = (_row or {}).get('vars') or {}
        if _v.get('caseId') and isinstance(_v.get('prFiles'), list):
            _FILES[_v['caseId']] = {p['filename'] for p in _v['prFiles']}

def ok(case_id, file, start, end, text='x', label=None):
    if not (text or '').strip(): return False
    if label == 'kody_rules': return True
    if not file or start is None or end is None: return False
    return file in _FILES.get(case_id, set())
