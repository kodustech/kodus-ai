#!/usr/bin/env python3
"""Saude de uma rodada, PR por PR, ANTES de olhar qualquer metrica.

Varias vezes a investigacao concluiu algo sobre a arquitetura quando o problema
era o harness: repo nao montado, diff truncado, agente que nao rodou, reducer
que falhou e postou tudo. Este script procura exatamente isso.

  python3 saude.py <pasta-do-pool> [log-da-rodada]

VERMELHO bloqueia (sai 2): a rodada nao mede o que diz medir.
AMARELO so avisa: vale abrir o PR antes de confiar no numero dele.
"""
import json, os, re, sys
from collections import Counter

PASSADAS = int(os.environ.get('SAUDE_PASSADAS', '0'))  # 0 = a moda da rodada
AGENTE_LENTO_MS = 10 * 60 * 1000
PR_LENTO_MIN = 10


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    pasta = sys.argv[1]
    log = open(sys.argv[2], errors='ignore').read() if len(sys.argv) > 2 and os.path.exists(sys.argv[2]) else ''
    dumps = sorted(f for f in os.listdir(pasta) if f.endswith('.raw.txt'))
    if not dumps:
        sys.exit('nenhum dump')
    carregados = [(f[:-8], json.load(open(os.path.join(pasta, f)))) for f in dumps]
    esperado = PASSADAS or Counter(len(d['trace']['recallPasses']) for _, d in carregados).most_common(1)[0][0]

    vermelho, amarelo = [], []
    tot_in = tot_cache = 0
    for cid, d in carregados:
        t = d['trace']; p = t.get('pipeline') or {}; ps = t.get('recallPasses') or []
        u = t.get('usage') or {}
        red = ((t.get('dedup') or {}).get('reducer')) or {}
        ver = t.get('verification') or {}
        cands = t.get('preFilterCandidates') or []
        tot_in += u.get('inputTokens', 0); tot_cache += u.get('cacheReadTokens', 0)
        v, a = [], []
        if not p.get('repoPrepared'): v.append('repo nao montado (ferramentas responderam do replay)')
        if p.get('filesInPrompt') != p.get('filesInFullDiff'):
            v.append(f"arquivos no prompt {p.get('filesInPrompt')} != diff {p.get('filesInFullDiff')}")
        if p.get('filesWithEmptyPatch'): a.append(f"{p['filesWithEmptyPatch']} arquivo(s) com patch vazio")
        if len(ps) != esperado: v.append(f'{len(ps)} passadas (esperado {esperado})')
        zero = [x['label'].replace('micro-', '') for x in ps if x.get('steps', 0) == 0]
        if zero: v.append('agente com 0 passos: ' + ', '.join(zero))
        sem_tool = [x for x in ps if x.get('steps', 0) > 0 and x.get('toolCalls', 0) == 0]
        if len(sem_tool) >= 3: a.append(f'{len(sem_tool)} agentes sem nenhuma ferramenta')
        lentos = [x['label'].replace('micro-', '') for x in ps if x.get('ms', 0) > AGENTE_LENTO_MS]
        if lentos: a.append('agente > 10 min: ' + ', '.join(lentos))
        if red.get('status') not in (None, 'success', 'skipped'):
            v.append(f"reducer {red.get('status')} (postou sem filtrar)")
        if u.get('reasoningTokens', 0) == 0 and (d.get('config') or {}).get('reasoningEffort'):
            a.append('esforco de raciocinio pedido, zero tokens de raciocinio')
        modos = Counter(x.get('parseMode') for x in ver.get('decisions') or [])
        if modos.get('default-keep') and not ((d.get('config') or {}).get('env') or {}).get('RECALL_SKIP_VERIFY') == '1': a.append(f"verificador sem veredito em {modos['default-keep']} (mantido por padrao)")
        wall = (t.get('reviewWallMs') or 0) / 60000
        if wall > PR_LENTO_MIN: a.append(f'PR levou {wall:.0f} min')
        if not cands: a.append('zero candidatos')
        # Chamada que esgotou as tentativas: sem modelo reserva no eval, a
        # passada do agente morre no meio e o PR sai com menos achados SEM
        # virar INFRA. Foi assim que o limite de taxa do Fireworks contaminou
        # uma rodada inteira com 10 PRs em paralelo.
        # Qualquer [LLM-ERROR] de chamada do agente e chamada perdida: ja veio como
        # RATE_LIMIT, como cota esgotada e como UNKNOWN ("servers are overloaded"),
        # e todas matam a passada.
        erros_llm = re.findall(r'\[LLM-ERROR\] bench:' + re.escape(cid) + r'(-recovery)?:', log)
        esgotadas = len(re.findall(re.escape(cid[:40]) + r'[^\n]*(?:usage limit has been reached)', log)) + sum(1 for x in erros_llm if not x)
        if esgotadas: v.append(f'{esgotadas} chamada(s) com erro final (limite, cota, sobrecarga) — passada incompleta')
        # A recuperacao de prosa (texto do agente que "parece achado" vira JSON) e uma
        # chamada a parte. Ate 26/09 ela ia para o modelo padrao do ambiente, que o
        # GPT por assinatura nao alcanca (MODEL_NOT_FOUND). Medido num PR com a
        # correcao: 9 recuperacoes, 0 achados devolvidos. Avisa, nao bloqueia.
        rec = sum(1 for x in erros_llm if x)
        if rec: a.append(f'{rec} recuperacao(oes) de prosa falharam')
        erros = len(re.findall(re.escape(cid[:40]) + r'[^\n]*(?:Error|ETIMEDOUT|ECONNRESET)', log))
        if erros: a.append(f'{erros} erro(s) no log')
        if v: vermelho.append((cid, v))
        if a: amarelo.append((cid, a))

    cfgs = Counter(json.dumps(d.get('config'), sort_keys=True) for _, d in carregados)
    print(f'{len(carregados)} PRs · {esperado} passadas por PR · cache {tot_cache / max(tot_in, 1) * 100:.0f}% · '
          f'{len(vermelho)} vermelho · {len(amarelo)} amarelo')
    if len(cfgs) > 1:
        vermelho.append(('(rodada)', [f'{len(cfgs)} configuracoes diferentes no mesmo pool']))
    for cid, msgs in vermelho:
        print(f'  VERMELHO {cid[:55]}: ' + '; '.join(msgs))
    for cid, msgs in amarelo:
        print(f'  amarelo  {cid[:55]}: ' + '; '.join(msgs))
    sys.exit(2 if vermelho else 0)


if __name__ == '__main__':
    main()
