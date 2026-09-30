#!/usr/bin/env python3
"""Confere uma rodada da arquitetura heavy (#1821) antes de pagar judge.

  python3 conferir-heavy.py <pool> [<dir de envelope>]

Por PR: quais passadas rodaram, se as lentes comecaram junto com o generalista
e o synthesis depois dele, se ha tokens de output por passada e custo do
verificador por achado, e quantas recuperacoes de prosa falharam.
"""
import json, glob, os, sys, collections

pool = sys.argv[1]
env_dir = sys.argv[2] if len(sys.argv) > 2 else None
ok_geral = True
for f in sorted(glob.glob(f'pools/{pool}/*.raw.txt')):
    j = json.load(open(f)); t = j['trace']; ps = t.get('recallPasses') or []
    por = collections.Counter()
    for p in ps:
        l = p['label']
        por['generalista' if l == 'generalist-base' else 'synthesis' if l == 'synthesis-rescue'
            else 'lente-1p' if l.startswith('micro-exp-p1g-') else 'lente-3p' if l.startswith('micro-exp-p3-') else l] += 1
    g = next((p for p in ps if p['label'] == 'generalist-base'), None)
    s = next((p for p in ps if p['label'] == 'synthesis-rescue'), None)
    lentes = [p for p in ps if p['label'].startswith('micro-exp-')]
    problemas = []
    if por.get('generalista') != 1: problemas.append('generalista ausente')
    if por.get('synthesis') != 1: problemas.append('synthesis ausente')
    if por.get('lente-1p') != 9: problemas.append(f"lentes 1p = {por.get('lente-1p', 0)}")
    if por.get('lente-3p') != 9: problemas.append(f"lentes 3p = {por.get('lente-3p', 0)}")
    if any(p['steps'] > 1 for p in ps if p['label'].startswith('micro-exp-p1g-')): problemas.append('lente 1p com >1 passo')
    if any(p['steps'] > 3 for p in ps if p['label'].startswith('micro-exp-p3-')): problemas.append('lente 3p com >3 passos')
    if g and lentes:
        ini_l = min(p['startEpochMs'] for p in lentes)
        if abs(ini_l - g['startEpochMs']) > 5000: problemas.append('lentes NAO comecaram junto com o generalista')
    if g and s and s['startEpochMs'] < g['startEpochMs'] + g['ms'] - 1000: problemas.append('synthesis comecou antes do generalista terminar')
    if any('outputTokens' not in p for p in ps): problemas.append('passada sem outputTokens')
    cands = t['preFilterCandidates']
    drops = [d for d in (t.get('verification') or {}).get('decisions') or [] if d.get('action') == 'drop']
    sem_custo = sum(1 for c in cands if not c.get('verifyCost')) + sum(1 for d in drops if not (d.get('droppedFinding') or {}).get('verifyCost'))
    if sem_custo: problemas.append(f'{sem_custo} achados sem verifyCost')
    tempo = lambda p: f"{p['ms']/1000:.0f}s" if p else '-'
    print(f"{j['caseId'][:40]:<42} modelo={(t.get('modelServed') or {}).get('modelId')}")
    print(f"   passadas {dict(por)} | generalista {tempo(g)} · synthesis {tempo(s)} · lentes (parede) "
          f"{(max(p['startEpochMs']+p['ms'] for p in lentes)-min(p['startEpochMs'] for p in lentes))/1000:.0f}s" if lentes else '')
    print(f"   candidatos {len(cands)} · descartados pelo verificador {len(drops)}")
    print('   ' + ('OK' if not problemas else 'PROBLEMAS: ' + '; '.join(problemas)))
    ok_geral &= not problemas
if env_dir and os.path.isdir(env_dir):
    falhas = glob.glob(f'{env_dir}/recovery-*.json')
    print(f'recuperacoes de prosa que falharam: {len(falhas)}')
    for x in falhas[:3]: print('   ', json.load(open(x)).get('message', '')[:160])
sys.exit(0 if ok_geral else 1)
