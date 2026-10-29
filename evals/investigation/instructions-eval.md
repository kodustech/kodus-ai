# instructions-eval.md

> **Para que serve este arquivo.** Ele descreve **como rodar o eval** do code
> review agêntico e, principalmente, **quais fases são o fluxo de produção e
> quais existem só offline, para medir**. Essa separação é o que impede alguém
> de concluir que "o produto faz X" quando X só roda no laboratório.
>
> Pré-requisito: `instructions-setup.md` já executado e verificado.
>
> Se você é um agente executando isto: o comando único está em §3. Não invente
> parâmetro, não improvise nome de rodada, e não reporte número sobre menos de
> 30 PRs.

---

## 1. Leia isto antes de qualquer coisa

Quatro regras que existem porque cada uma já invalidou medição:

**São sempre 30 PRs.** O universo é `LIGHT_CASES` (congelado em
`light-30.json`): **30 PRs, 120 goldens, 111 core**. PR que não gerou
comentário **entra na conta** com 0 achados e os goldens dele no denominador.
Tabela com 29 PRs está errada, não "quase certa" — o denominador encolhido
infla o recall sozinho.

**Não compare rodadas de dias diferentes sem controle.** A variância medida
entre rodadas da mesma configuração chega a **8pp de recall**. Diferença menor
que isso não é efeito. Quando puder, compare **dois braços da mesma rodada**
(ex.: com e sem um agente, removendo os candidatos dele deterministicamente) —
aí a variância é zero por construção.

**Nunca misture pools de configurações diferentes.** Um pool colado de duas
rodadas com número de passadas diferente não representa configuração nenhuma.
Se precisar de baseline, gere a baseline.

**Piso de ruído: ±0,026 de F1.** Ganho menor que isso não é ganho.

---

## 2. As fases, e onde cada uma vive

Esta é a parte que mais gera confusão. Leia a coluna da direita.

| # | fase | roda em **produção**? |
|---|---|---|
| 1 | **generalista** — uma passada ampla sobre o diff inteiro | **sim** |
| 2 | **synthesis-rescue** — uma passada a mais procurando o que a base perdeu | **sim** em produção; **desligada** no protocolo (`RECALL_SKIP_SYNTHESIS=1`) |
| 3 | **verify** — o verificador julga cada candidato (mais o evidence gate) | **sim** |
| 4 | **dedup** — no mesmo modelo da review | **sim** |
| — | — | — |
| 5 | **judge** — casa achado com golden | **não.** Só medição |
| 6 | **relatório** e **trace debugger** | **não.** Só medição |

### O que isso significa na prática

**O reducer não existe mais.** `finding-reducer.ts` saiu de `libs/`; produção
faz generalista → synthesis-rescue → verify → (ancoragem, repetidos) → dedup →
severidade/enriquecimento e posta o que sobra (`AgentReviewStage`).
Atribuidor, veracidade e fórmula (que só alimentavam o reducer) saíram do
protocolo.

**Os microagentes, a simulação mental, o scout, o painel, o shard e o
dev-level também saíram** do `libs/` e do harness. Números deles abaixo são
histórico.

**O judge não é parte do produto.** Ele é o instrumento de medida. Julga
**todos os candidatos** (o que o verify manteve, antes do dedup), não os
representantes dos grupos — representante mudaria a definição de "o grupo cobre
o golden", que hoje significa *o dono do golden está no grupo*. Os descartados
pelo verify são julgados à parte (`matriz-descartados-<rodada>.json`).

### Ordem de dependência

```
geração (generalista → verify → dedup)
        │
        ▼
portão (30 dumps) → saude.py
        │
        ├──────────────────┐
        ▼                  ▼
      judge      judge dos descartados    rodam em paralelo
        │                  │
        ▼                  │
   relatório ◄─────────────┘  (relatorio.py)
        │
        ▼
   trace debugger
```

---

## 3. O comando

```bash
cd evals/investigation
./protocolo.sh <modelo> [nome-da-rodada]
```

Exemplos:

```bash
./protocolo.sh deepseek-v4.1-flash@fireworks            # nomeia sozinho: 25.09.26_v1
./protocolo.sh gpt-5.6-sol@sub 25.09.26_v2_crossfile    # ou você nomeia
```

**Padrão de nome: `DD.MM.AA_vN[_titulo]`.** Sem o segundo argumento ele usa a
data de hoje e o próximo `vN` livre. Recusa nome fora do padrão e recusa
sobrescrever pasta existente.

### O que o protocolo faz, em ordem

1. **geração** — generalista → verify → dedup, nos 30 PRs (sem synthesis-rescue)
2. **portão** — 30 dumps e zero INFRA, ou aborta; depois `saude.py`, vermelho aborta
3. **judge ∥ judge dos descartados** — em paralelo
4. **relatório** e **trace debugger** — offline

> A fase 1 chama `run-recall-1821.js` (harness de pesquisa): é ele que lê
> `RECALL_SKIP_SYNTHESIS` e `RECALL_REAL_REPO` e grava
> `trace.preFilterCandidates`, a entrada do judge. `run-recall.js` é o harness
> de produção.

### Configuração congelada (não há o que passar)

```
RECALL_SET=light              os 30 PRs
RECALL_SKIP_SYNTHESIS=1       sem synthesis-rescue
RECALL_REAL_REPO=1            worktree de verdade
RECALL_GATE=0                 sem gate
RECALL_CONCURRENCY=8          8 PRs em paralelo (sobrescrevível)
```

Para modelos `gpt-*` o protocolo já força `RECALL_REASONING_EFFORT=low`.
DeepSeek pensa por padrão e **não aceita "ligar"** — medido na Fireworks, o
default já entrega o volume máximo de raciocínio e os parâmetros só reduzem.

### O que você **pode** mexer

| variável | quando |
|---|---|
| `RECALL_CONCURRENCY` | mantenha o mesmo valor se for comparar **tempo** entre rodadas |
| `RECALL_CALL_GRAPH=1` | só para re-testar grafo (ver setup) |

### Duração e custo

| | |
|---|---|
| geração | ~55 min (varia muito com o provedor) |
| judge ∥ judge dos descartados | ~10 min |
| **total** | **~1h05** |
| custo DeepSeek/Fireworks | ~US$ 8 na rodada inteira |
| modelos `@sub` | consome cota do plano, não dinheiro |

---

## 4. Se algo falhar

| sintoma | causa | o que fazer |
|---|---|---|
| `ABORTADO: N/30 dumps` | cota, rate limit ou agente com zero passos | resolver a causa e **rodar tudo de novo**. Não remende PRs avulsos: misturar regimes no mesmo pool é o erro do `gpt-30` |
| `The usage limit has been reached` | cota do plano de assinatura | esperar a janela virar, ou trocar de modelo. Login novo não resolve |
| recall muito abaixo do esperado, sem erro | ver §6 | antes de culpar o código, comparar o trabalho por passo |
| `ABORTADO: saude vermelha` | o `saude.py` achou falha de harness num PR: repo não montado, arquivo faltando no prompt, agente com 0 passos, pool com configurações misturadas | abrir `results/saude-<rodada>.log`, corrigir o harness e rodar de novo. Amarelo não bloqueia, mas vale abrir o PR antes de confiar no número dele |
| `NAO COMPARAVEL` no `comparar-config.py` | as duas rodadas diferem em algo além do braço declarado | não compare. Rode os dois braços com a mesma configuração |

### O que cada rodada grava desde 26/09

- `config` em cada dump: hash do código e dos datasets, modelo, esforço, janela de contexto, busca de docs e as `RECALL_*`. O `relatorio.py` para se o pool mistura configurações; `python3 comparar-config.py A B --braco=<chave>` diz se duas rodadas podem ser comparadas.
- `verification.verifyMs` e, em cada descarte, `droppedFinding` com o texto. O protocolo julga os descartados em `results/matriz-descartados-<rodada>.json`: é assim que se sabe se o verificador joga fora bug bom.
- `searchDocs` (Exa) ligado nos agentes, como na produção. `RECALL_DOCS=0` desliga, para o braço de comparação.
- 8 PRs em paralelo por padrão (`RECALL_CONCURRENCY`).

**Nunca pontue pelo campo `findings` de um dump antigo que não passou pelo
reducer (hoje removido).** Foi o caminho que produziu um "baseline" de 0,356
com 208 falsos positivos, que não corresponde a nenhuma configuração real.

---

## 5. Ler o resultado

```bash
python3 relatorio.py --run=<nome>
python3 relatorio.py --run=<nome> --secao=prereducer   # uma seção só
```

Seções: `tempo`, `tokens`, `prereducer`, `agentes`.

O que cada uma responde:

| seção | pergunta |
|---|---|
| `tempo` | quanto durou cada fase (menor, mediana, média, maior) |
| `tokens` | input fresco, cache read e output por PR |
| `prereducer` | recall/precision/F1/F2 pós-verify, pré-dedup (cabeçalho `PRE-DEDUP`; a chave tem nome histórico; a linha "sem o agente cross-file" só tem efeito em pool de microagentes) |
| `agentes` | TP e FP por agente, totais e únicos |

### Convenções que o relatório respeita

- **Regra da métrica:** por golden vence o candidato de maior confiança; candidato
  que não vence nenhum golden é FP. É a mesma regra do leaderboard.
- **Perfil core:** 111 dos 120 goldens (categorias `bug`, `security`,
  `concurrency`, `data`, `api`, `perf`, `test_gap`, `doc_defect`).

---

## 6. Como distinguir "nossa mudança" de "o provedor mudou"

Isto já aconteceu e custou um dia. A checagem, em ordem:

**1. A entrada é a mesma?** Some `pipeline.filesInPrompt`,
`pipeline.userPromptChars` e `pipeline.systemPromptChars` nos 30 PRs das duas
rodadas. Se baterem, o prompt é idêntico e a causa não está na montagem.

**2. Os prompts dos agentes são os mesmos?** Gere os prompts nas duas versões
do código e compare o md5. Idênticos = o código de geração está inocente.

**3. O agente trabalhou igual?** Compare por passo, não por PR:

- `toolCalls / steps` — quantas ferramentas por turno
- `outputTokens / steps` — quanto texto por turno
- `reasoningTokens / steps` — quanto raciocínio por turno

**Menos achados com o mesmo número de passos e menos trabalho por turno é
assinatura de mudança do provedor.** Menos achados com menos passos pode ser
timeout ou orçamento — verifique `finishReason` e `warnings`.

**4. A queda é uniforme entre as passadas?** Se todas caem na mesma proporção,
a causa é comum — e a única coisa comum é o modelo. Se uma cai sozinha, é
mudança no prompt dela.

**5. Ferramenta quebrada?** Confira no log: erros de ferramenta, falha de
worktree, `replayCalls` desproporcional. Zero em tudo significa que o repo real
foi montado e as ferramentas responderam.

**6. Modelo trocado?** O campo `trace.modelServed.modelId` guarda **o que a
gente pediu**, não o que foi servido. Para saber o que rodou de verdade, olhe o
**Langfuse**.

---

## 7. O que já foi decidido (não re-teste sem motivo)

Medições da arquitetura de microagentes + reducer, que já não existe; ficam como
histórico.

| questão | veredito | evidência |
|---|---|---|
| grafo AST no prompt dos agentes | **piora** | −0,049 F1 DeepSeek, −0,019 GPT |
| fundir 12 agentes em 8 | **piora** | −5,5pp de recall, −6 goldens |
| verify no lugar/ao lado da veracidade | **não paga** | +0,016 GPT (ruído), 0,000 DeepSeek |
| 8 passos no verify vs 5 | 8 responde quase sempre; 5 não responde em 56 casos | — |
| microagentes, simulação e reducer | **removidos** de `libs/` e do harness | — |
| agente cross-file | **soma** | +4,6pp de recall, precisão intacta, mesmo pool |

E o diagnóstico de fundo, que deve guiar o que se testa a seguir:

**O gargalo é a geração, não o corte** (medido com os microagentes). Dos 111 goldens core, ~60 são
alcançados por algum agente e praticamente todos esses sobrevivem ao reducer.
Os ~50 restantes nunca viram candidato. Afinar cota, limiar ou fórmula
redistribui os 60; não traz nenhum dos 50.
