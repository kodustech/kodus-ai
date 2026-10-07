import csv, json, sys
# uma linha por comentario saido do dedup + revisao (rep), com atribuidor, fila e verify
nome, fus, pool, nota, fila, ver, out = sys.argv[1:8]
# topo protegido e se a derrubada exige ter lido o arquivo citado (bruto = nao exige)
TOPO = int(sys.argv[8]) if len(sys.argv) > 8 else 3
BRUTO = len(sys.argv) > 9 and sys.argv[9] == 'bruto'
F = json.load(open(fus))['prs']; N = json.load(open(nota))['prs']; Q = json.load(open(fila)); V = json.load(open(ver))['prs'] if ver != '-' else {}
cols = ['pr', 'rep', 'membros', 'agentes', 'arquivo', 'linha_ini', 'linha_fim', 'texto_final', 'nota_atribuidor', 'porque_atribuidor',
        'na_fila_65', 'posicao_fila', 'topo_protegido', 'verify_keep', 'verify_leu_arquivo_citado', 'sai_no_verify', 'verify_justificativa']
with open(out, 'w', newline='') as fh:
    w = csv.writer(fh); w.writerow(cols)
    for c in Q:
        cs = json.load(open(f'pools/{pool}-heavysv/{c}.raw.txt'))['trace']['preFilterCandidates']
        notas = {it['rep']: it for it in N.get(c, {}).get('itens', [])}
        dec = V.get(c, {}).get('decisoes', {})
        for it in F[c]['itens']:
            r = it['rep']; x = cs[r]; pos = Q[c].index(r) + 1 if r in Q[c] else ''
            d = dec.get(str(r), {}).get('v1') if pos else None
            w.writerow([c, r, ' '.join(map(str, it['membros'])), ' '.join(sorted({cs[m].get('producedBy', '') for m in it['membros']})),
                        x.get('relevantFile'), x.get('relevantLinesStart'), x.get('relevantLinesEnd'), it.get('texto') or x.get('suggestionContent'),
                        notas.get(r, {}).get('nota', ''), notas.get(r, {}).get('porque', ''),
                        'sim' if pos else 'nao', pos, 'sim' if pos and pos <= TOPO else ('nao' if pos else ''),
                        '' if not d else ('sim' if d['keep'] else 'nao'), '' if not d else ('sim' if d['leuCitado'] else 'nao'),
                        '' if not d else ('sim' if pos > TOPO and d['keep'] is False and (BRUTO or d['leuCitado']) else 'nao'),
                        '' if not d else d.get('texto', '')])
print(out)
