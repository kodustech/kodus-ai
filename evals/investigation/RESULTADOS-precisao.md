# Precisão do pool pós-review — testes 16 a 25

Meta: recall ≥55% **e** precisão ≥50%, mexendo só no que vem depois da geração.
Base fixa: 29 PRs leves, golden set v002, perfil `core` (108 goldens), pool
`sol-teto2` (15 micro-agentes com teto 2 + simulação, filtro de contrato).
Toda formula é ajustada com leave-one-out por PR.

## Resultado

**Meta não atingida.** Os dois alvos não se encontram: onde o recall chega a
55% a precisão fica em 39%; onde a precisão passa de 50% o recall cai para 47%.

Melhor configuração medida — cota de 4 por PR com prob ≥ 0.26:

| | recall | precisão | F1 | F2 | coment/PR |
|---|---|---|---|---|---|
| ponto de partida | 52.8% | 26.5% | 0.353 | 0.440 | 7.1 |
| **melhor F1** | 47.2% | **54.8%** | **0.507** | 0.486 | 3.1 |
| melhor com recall ≥55% | 55.6% | 39.0% | 0.458 | 0.512 | 5.3 |
| Kodus em produção (mesmos PRs) | 34.2% | 63.3% | — | — | 2.0 |

## Testes

| # | hipótese | resultado |
|---|---|---|
| 16 | 2º escore perguntando "um revisor humano escreveria isto?" | AUC 0.730 vs 0.731 — neutro |
| 17 | termos de produto para todo par ortogonal | AUC 0.731 — nada |
| 18 | cota por PR em vez de corte global | **ganho**: top-4/PR 49.1%/47.7% |
| 19 | limiar diferente por estrato de concordância | nada — `nag` já era feature |
| 20 | ensemble de 5 atribuidores | AUC 0.736 — dentro do ruído |
| 21 | fundir grupos por arquivo | 56.5%/49.2% — **mas contabilidade otimista** |
| 22 | a mesma fusão sob contabilidade pessimista | 47.2%/39.2% — o ganho dependia do texto |
| 23 | compor o texto fundido e re-julgar | **49.1%/39.6% — fusão é perda líquida** |
| 24 | fusão com teto de 3 grupos por comentário | 48.1%/35.6% — pior que a fusão livre |
| 25 | editor por PR, escolha comparativa | 45.4%/44.1% no top-4 — pior que a fórmula |

## O que ficou estabelecido

**Ortogonalidade paga, força não.** `hum` é o melhor sinal isolado (AUC 0.716,
acima da própria nota do atribuidor, 0.704) e não acrescenta nada, porque
correlaciona 0.642 com ela. `ver` é fraco sozinho (0.586) e quase independente
(0.079) — por isso `nota × ver` chega a 0.735. Um segundo escore só vale o que
ele discorda do primeiro.

**O escore saturou em AUC ≈ 0.74.** Nove variações da fórmula, cinco
atribuidores em ensemble, quatro segundos-escores diferentes e uma ordenação
comparativa caem todos na mesma faixa. Não é falta de feature: é o limite do
que essas perguntas conseguem separar neste pool.

**Fundir comentários não funciona, e a medida ingênua mente.** Juntar achados
do mesmo arquivo num comentário só prometia 56.5%/49.2%. Re-julgado com o texto
de fato composto, entrega 49.1%/39.6%: o blob concatenado dilui o conteúdo e o
judge passa a casar 53 goldens em vez de 66. O maior balde juntava 12 achados
das linhas 35 a 168 — autorização, performance e classificação de e-mail no
mesmo comentário. Não era uma técnica, era colapsar FPs para agradar uma régua
que conta comentários.

O teto de 3 por comentário (teste 24) não recupera nada: 48.1%/35.6%, pior que
a fusão livre. Limitar o tamanho mantém a diluição do texto e ainda devolve
mais comentários — 142 contra 128. A conclusão vale para a família inteira.

**A meta é alcançável em princípio, e o gargalo é ordenar dentro do PR.** Com
ordenação perfeita e 4 comentários por PR o pool dá 59.3%/57.7%. Com a nossa,
49.1%/47.7%. Toda a distância restante está em escolher quais 4, e é
exatamente onde tudo saturou.

## Correção

O harness consultava as tabelas de 2º escore pelo índice do pool **filtrado**,
enquanto elas são gravadas pelo índice **original** do candidato. Afetava 8 de
222 grupos. Corrigido em `ajustar-formula.py`; o AUC do baseline subiu de 0.731
para 0.741. Os números acima já são os corrigidos.

## Scripts

`ajustar-formula.py` (ajuste + LOO + curva), `pontuar-fundido.py`,
`pontuar-editor.py`, `teste25.py`, `fundir-por-arquivo.js`,
`score2-humano.js`, `editor-por-pr.js`.
