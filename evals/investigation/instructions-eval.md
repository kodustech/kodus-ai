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
| 1 | **13 microagentes** em paralelo (fase 0) | **sim** |
| 2 | **mental simulation** (fase 1), vendo o que a fase 0 levantou | **sim** |
| 3 | **filtro de contrato** — descarta achado sem `reason` ou com severidade fora da escala | **sim** (determinístico, dentro do reducer) |
| 4 | **atribuidor** — agrupa duplicatas e dá nota 0-100 por grupo | **sim** (1 chamada por PR) |
| 5 | **veracidade** — 0-100 de "a alegação é verdadeira sobre este código" | **sim** (1 chamada por PR) |
| 6 | **fórmula logística + cota + limiar** | **sim** (determinístico) |
| — | — | — |
| 7 | **judge** — casa achado com golden | **não.** Só medição |
| 8 | **verify** — agente por grupo, com grep/readFile no repo | **não.** Só experimento |
| 9 | **relatório** | **não.** Só medição |

### O que isso significa na prática

**O reducer de produção é: contrato → atribuidor → veracidade → fórmula.** Duas
chamadas de LLM por PR, mais aritmética. É o que está em
`libs/code-review/infrastructure/agents/engine/finding-reducer.ts`.

**O verify nunca esteve em produção.** Nada em `libs/` ou `apps/` instancia o
`LlmVerifier` no caminho de review. Ele existe nos scripts de eval, roda
**depois** da geração, sobre os grupos que o atribuidor montou. Colocá-lo em
produção seria trabalho novo, com custo de 1 execução de agente **por grupo**
somado ao tempo da review — e pelo que já foi medido não paga: +0,016 de F1 no
GPT (dentro do ruído) e **0,000 no DeepSeek**, com 124 de 125 grupos pontuados.

**O judge não é parte do produto.** Ele é o instrumento de medida. Julga
**todos os candidatos**, não os representantes dos grupos — representante não
responde nada por agente e mudaria a definição de "o grupo cobre o golden", que
hoje significa *o dono do golden está no grupo*.

**O agente cross-file (`changed-files-disagree`) roda na fase 0 com os outros,
mas o que ele produz NÃO entra no `<AlreadyRaised>` da simulação.** É
deliberado: mantém a simulação inalterada, e assim remover os candidatos dele
offline reproduz exatamente a rodada de 12 agentes.

### Ordem de dependência

```
geração (fases 1-2)
        │
        ├──────────────┬──────────────┐
        ▼              ▼              │
   filtro de        judge             │   judge e atribuidor não dependem
    contrato     (todos os           │   um do outro: rodam em paralelo
        │         candidatos)         │
        ▼                             │
   atribuidor ◄───────────────────────┘
        │
        ├──────────────┬──────────────┐
        ▼              ▼              │
   veracidade       verify            │   dependem do agrupamento,
        │              │              │   não um do outro
        └──────┬───────┘              │
               ▼                      │
           fórmula ◄──────────────────┘
               │
               ▼
           relatório
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

1. **geração** — 13 microagentes + simulação, nos 30 PRs
2. **portão** — 30 dumps e zero INFRA, ou aborta
3. **judge ∥ atribuidor** — em paralelo
4. **veracidade ∥ verify** — em paralelo
5. **relatório**

### Configuração congelada (não há o que passar)

```
RECALL_SET=light              os 30 PRs
RECALL_MICRO_AGENTS=1+sim     13 agentes + simulação
RECALL_FINDING_REASON=1       todo achado traz o percurso (o contrato exige)
RECALL_SKIP_SYNTHESIS=1       sem synthesis-rescue
RECALL_SKIP_BASE_PASS=1       sem a passada generalista
RECALL_REAL_REPO=1            worktree de verdade
RECALL_REDUCER=v2             reducer de produção dentro da rodada
RECALL_GATE=0                 sem gate de piso
RECALL_CONCURRENCY=4          4 PRs em paralelo
```

Para modelos `gpt-*` o protocolo já força `RECALL_REASONING_EFFORT=low`.
DeepSeek pensa por padrão e **não aceita "ligar"** — medido na Fireworks, o
default já entrega o volume máximo de raciocínio e os parâmetros só reduzem.

### O que você **pode** mexer

| variável | quando |
|---|---|
| `RECALL_CONCURRENCY` | mantenha 4 se for comparar **tempo** entre rodadas |
| `RECALL_SKIP_AGENTS=<id>` | desligar um agente para medir o que ele paga |
| `RECALL_CALL_GRAPH=1 RECALL_MICRO_GRAPH=1` | só para re-testar grafo (ver setup) |

### Duração e custo

| | |
|---|---|
| geração | ~55 min (varia muito com o provedor) |
| judge ∥ atribuidor | ~10 min |
| veracidade ∥ verify | ~25 min |
| **total** | **~1h30** |
| custo DeepSeek/Fireworks | ~US$ 8 na rodada inteira |
| modelos `@sub` | consome cota do plano, não dinheiro |

---

## 4. Se algo falhar

| sintoma | causa | o que fazer |
|---|---|---|
| `ABORTADO: N/30 dumps` | cota, rate limit ou agente com zero passos | resolver a causa e **rodar tudo de novo**. Não remende PRs avulsos: misturar regimes no mesmo pool é o erro do `gpt-30` |
| `The usage limit has been reached` | cota do plano de assinatura | esperar a janela virar, ou trocar de modelo. Login novo não resolve |
| recall muito abaixo do esperado, sem erro | ver §6 | antes de culpar o código, comparar o trabalho por passo |
| `score ausente` em muitos grupos do verify | extração do modo score | já corrigido com `scoreFromText`; se voltar, é regressão |

**Nunca pontue pelo campo `findings` do dump quando a rodada não passou pelo
reducer.** É o caminho que produziu um "baseline" de 0,356 com 208 falsos
positivos, e ele não corresponde a nenhuma configuração real.

---

## 5. Ler o resultado

```bash
python3 relatorio.py --run=<nome>
python3 relatorio.py --run=<nome> --secao=prereducer   # uma seção só
```

Seções: `tempo`, `tokens`, `prereducer`, `agentes`, `formula`.

O que cada uma responde:

| seção | pergunta |
|---|---|
| `tempo` | quanto durou cada fase (menor, mediana, média, maior) |
| `tokens` | input fresco, cache read e output por PR |
| `prereducer` | recall/precision/F1/F2 antes de qualquer corte, **com e sem o agente cross-file** |
| `agentes` | TP e FP por agente, totais e únicos |
| `formula` | as três variantes nos cortes 3-7 |

### Convenções que o relatório respeita

- **Regra da métrica:** por golden vence o candidato de maior confiança; candidato
  que não vence nenhum golden é FP. É a mesma regra do leaderboard.
- **Perfil core:** 111 dos 120 goldens (categorias `bug`, `security`,
  `concurrency`, `data`, `api`, `perf`, `test_gap`, `doc_defect`).
- **Pesos sempre reajustados leave-one-out por PR** — o PR avaliado nunca entra
  no fit. Os pesos publicados ficam de fora de propósito, para não existirem
  dois números para a mesma pergunta.
- **Limiar 0,22**, cortes (cota por PR) 3 a 7.

### As três variantes da fórmula

| | sinal além do atribuidor |
|---|---|
| **A** | veracidade *(é a de produção)* |
| **B** | veracidade + verify |
| **C** | verify sozinho |

O atribuidor é fixo em todas: a nota dele é termo da fórmula.

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

**4. A queda é uniforme entre os 13 agentes?** Se todos caem na mesma proporção,
a causa é comum a todos — e a única coisa comum é o modelo. Se um agente cai
sozinho, é mudança no prompt dele.

**5. Ferramenta quebrada?** Confira no log: erros de ferramenta, falha de
worktree, `replayCalls` desproporcional. Zero em tudo significa que o repo real
foi montado e as ferramentas responderam.

**6. Modelo trocado?** O campo `trace.modelServed.modelId` guarda **o que a
gente pediu**, não o que foi servido. Para saber o que rodou de verdade, olhe o
**Langfuse**.

---

## 7. O que já foi decidido (não re-teste sem motivo)

| questão | veredito | evidência |
|---|---|---|
| grafo AST no prompt dos agentes | **piora** | −0,049 F1 DeepSeek, −0,019 GPT |
| fundir 12 agentes em 8 | **piora** | −5,5pp de recall, −6 goldens |
| verify no lugar/ao lado da veracidade | **não paga** | +0,016 GPT (ruído), 0,000 DeepSeek |
| 8 passos no verify vs 5 | 8 responde quase sempre; 5 não responde em 56 casos | — |
| 3 microagentes fracos | **removidos** | nenhum achado sobreviveu ao reducer |
| agente cross-file | **soma** | +4,6pp de recall, precisão intacta, mesmo pool |

E o diagnóstico de fundo, que deve guiar o que se testa a seguir:

**O gargalo é a geração, não o corte.** Dos 111 goldens core, ~60 são
alcançados por algum agente e praticamente todos esses sobrevivem ao reducer.
Os ~50 restantes nunca viram candidato. Afinar cota, limiar ou fórmula
redistribui os 60; não traz nenhum dos 50.
