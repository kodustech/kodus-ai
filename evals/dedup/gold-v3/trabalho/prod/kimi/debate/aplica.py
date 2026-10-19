"""Aplica uma rodada ao estado e fecha o que convergiu.
  python3 aplica.py opus r1_out*.json   |   python3 aplica.py astra <rodada>"""
import json,sys,glob,os
W=os.path.dirname(os.path.abspath(__file__))
N={'low':0,'medium':1,'high':2,'critical':3}
S=json.load(open(f'{W}/estado.json'))
quem=sys.argv[1]
novos={}
if quem=='opus':
    for f in sys.argv[2:]: novos.update(json.load(open(f'{W}/{f}')))
else:
    for f in glob.glob(f'{W}/astra_r{sys.argv[2]}/*.json'):
        for it in json.load(open(f))['items']: novos[it['issueId']]=it
for k,v in S.items():
    if v.get('fechado'): continue
    if quem=='opus' and k in novos:
        x=novos[k]
        if v['hist'][-1]['who']=='astra':
            v['hist'].append({'who':'opus','class':x['class'],'subclass':x.get('subclass') or 'none','severity':x.get('severity') or 'none','text':x['text'],'concede':x.get('concede')})
    if quem=='astra' and k in novos:
        x=novos[k]
        if v['hist'][-1]['who']=='opus':
            v['hist'].append({'who':'astra','class':x['class'],'subclass':x['subclass'],'severity':x['severity'],'text':x['reply']})
    o=next(h for h in reversed(v['hist']) if h['who']=='opus'); a=next(h for h in reversed(v['hist']) if h['who']=='astra')
    sevok=not v['precisaSeveridade'] or o['severity']=='none' or a['severity']=='none' or abs(N[o['severity']]-N[a['severity']])<2
    if o['class']==a['class'] and o['subclass']==a['subclass'] and sevok: v['fechado']='consenso'
json.dump(S,open(f'{W}/estado.json','w'),indent=1)
abertos=[k for k,v in S.items() if not v.get('fechado')]
print('fechados',len(S)-len(abertos),'abertos',len(abertos),'aguardando astra',sum(1 for k in abertos if S[k]['hist'][-1]['who']=='opus'))
