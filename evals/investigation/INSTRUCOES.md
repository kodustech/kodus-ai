# Instruções — harness de benchmark de recall

Este arquivo existe para quem vai **continuar** a investigação de recall do code
review agêntico (issue #1821) sem ter participado dela. Ele documenta como o
harness é acionado, o que cada configuração faz e quais armadilhas já custaram
runs inteiros.

Ele mora junto dos arquivos de teste de propósito e **não deve subir para a
versão final do produto** — é documentação de bancada.

> **Aviso sobre números.** Tudo que foi medido antes de 19/09/2026 usou um diff
> truncado em 6 arquivos por PR. Esses números **não são comparáveis** com
> nenhum medido depois. Veja "O corpus" abaixo.

---

## 1. O comando

```bash
node evals/investigation/run-recall.js --model <modelo> --cases <ids> --output <arquivo.json>
```

Roda sempre a partir da **raiz do repositório** (`/Users/juniorsartori/Projects/Kody/kodus-ai`),
nunca de dentro de `evals/investigation` — os caminhos de `tsconfig-paths` são
resolvidos a partir da raiz.

### Argumentos de linha de comando

| flag | o que faz |
|---|---|
| `--model <id>` | modelo do agente que revisa. Ex: `gpt-5.6-sol@sub`. Default `gpt-5.4` |
| `--cases <a,b,c>` | lista explícita de `caseId`, separada por vírgula |
| `--set <nome>` | conjunto pronto: `smoke` (5 casos / 25 goldens), `pr` (8 / 38), `light` (30 / 95). Default `pr` |
| `--all` | todos os casos de `datasets/`, os 53 |
| `--limit <n>` | corta o conjunto nos primeiros n |
| `--output <arquivo>` | onde gravar o resultado. **Sempre passe** — o checkpoint deriva dele, e duas rodadas sem `--output` distinto sobrescrevem uma à outra |
| `--threshold <n>` | piso de recall para o gate |
| `--gate` | liga o gate de piso por modelo (`targets.json`) |

Toda flag tem uma variável de ambiente equivalente (`RECALL_MODEL`,
`RECALL_SET`, `RECALL_CASES`, `RECALL_ALL`, `RECALL_THRESHOLD`,
`RECALL_GATE`, `RECALL_CONCURRENCY`).

### O conjunto `light` é o que vale

Os 30 PRs de `LIGHT_CASES` em `recall-tests.js` são o benchmark da
investigação: 95 golden comments, 5 repositórios reais (cal.com, sentry,
grafana, keycloak, discourse). Todo número que vale comparação foi medido nele.

---

## 2. O que sai de um run

| arquivo | conteúdo |
|---|---|
| `<output>.json` | métricas por caso e agregadas, `tokenUsage`, `traceSummary` |
| `<output>.submission.json` | os findings postados |
| `<output>.debug.html` | **o debugger de PR** — gerado automaticamente |
| `$RECALL_DUMP/<caseId>.raw.txt` | saída crua do agente, gravada ANTES do judge |

### `RECALL_DUMP=<dir>` — ligue sempre

Grava a saída crua por caso antes do judge rodar. A revisão em si é a parte cara
(minutos de agent loop real); se o judge quebrar depois — rate limit, crédito,
parse — sem o dump a única forma de reavaliar é pagar a revisão inteira de novo.

O dump também é a **entrada do debugger de PR**: sem ele, nenhuma página é
gerada no fim do run.

Use um diretório novo por run (`rm -rf $DIR` antes), senão casos de runs
anteriores entram na página.

### O debugger de PR

Gerado sozinho no fim de todo run que tenha `RECALL_DUMP`. Para gerar à mão:

```bash
node evals/investigation/build-trace-debugger.js --run=<nome-da-rodada>
```

São 13 verificações **computadas** por PR — não asseridas. A contagem de
arquivos é conferida contra `git diff --name-status` no clone real, o formato do
diff é inspecionado no prompt que foi de fato enviado, e as chamadas do modelo
são lidas no transporte. Cada PR ganha link direto para seus traces no Langfuse.

Existe por um motivo concreto: três bugs de medição desta investigação só
apareceram quando alguém leu um dump à mão. Todos produziam números que
pareciam normais.

---

## 3. Langfuse

Registrado em `agent-provider.js:13-47`, **depois** do `dotenv` e nunca antes.

```
LANGFUSE_TRACING=true
LANGFUSE_PUBLIC_KEY=<...>
LANGFUSE_SECRET_KEY=<...>
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
LANGFUSE_ENVIRONMENT=benchmark
```

As chaves vêm do `.env` e depois do `.env.local` com `override: true` — o
`.env.local` ganha. O ambiente é forçado para `benchmark` quando não vier
definido (`agent-provider.js:23`), justamente para os traces de bancada não se
misturarem com os de produção no mesmo projeto.

No começo do run o harness imprime uma linha dizendo se o tracing subiu:

```
[langfuse] tracing ON · env=benchmark · https://us.cloud.langfuse.com
```

Se aparecer `OFF`, ela diz qual chave está faltando. Trace ligado exige as três
coisas: `LANGFUSE_TRACING=true` **e** as duas chaves.

### Como os traces se chamam

Cada PR vira traces chamados `bench:<caseId>`, mais irmãos com sufixo
(`bench:<caseId>-plan`, `-recovery`). **Um run não produz um trace por PR**:
toda chamada de modelo que começa sem span pai vira trace raiz próprio, então um
PR aparece como vários. O debugger lista todos.

### Três armadilhas já pagas aqui

1. Precisa de **`registerLangfuseStandalone()` E `registerLangfuseAiSdkTelemetry()`** — só o primeiro não basta.
2. Precisa da porta `LlmObservability` registrada (`eval-observability.js`). Em produção o NestJS injeta; no eval não existe container, então sem isso nenhum span é criado. Não é span descartado — é span nunca criado.
3. O `LangfuseSpanProcessor` **descarta** spans de escopo de instrumentação que ele não reconhece, logando `Dropped span due to shouldExportSpan filter`. Span OTel feito à mão não chega. Use `startActiveObservation` de `@langfuse/tracing`.

### Consultando a API

O endpoint `/api/public/traces` responde **422 "Request timed out"** sem filtro
de data — o projeto tem tráfego de produção demais para varredura aberta.
Sempre passe `fromTimestamp`. É o que `langfuse-traces.js` faz.

---

## 4. As configurações de arquitetura

Aqui está o que a pessoa precisa para montar uma receita. As variáveis abaixo
são todas `=1` para ligar, salvo onde indicado.

### Infraestrutura — quase sempre ligadas

| variável | efeito |
|---|---|
| `RECALL_REAL_REPO=1` | as tools (`grep`, `readFile`, `checkTypes`) rodam contra um **clone de verdade** no commit do PR, via `LocalRepoCommands`. Sem isso o harness cai no `ReplayRemoteCommands`, que só devolve o que foi gravado no `toolReplay` do dataset |
| `RECALL_CALL_GRAPH=1` | injeta o bloco `<CallGraph>` no prompt, construído na hora pelo kodus-graph sobre o clone. **Exige `RECALL_REAL_REPO=1`** |
| `RECALL_MAX_STEPS=<n>` | teto de passos do loop. Veja a nota abaixo — não é só um teto |
| `RECALL_REASONING_EFFORT=low\|medium\|high` | injeta o effort de verdade na chamada |
| `RECALL_CONCURRENCY=<n>` | PRs em paralelo. Default 4 |
| `RECALL_MODEL` / `RECALL_PROVIDER` / `RECALL_BASEURL` / `RECALL_APIKEY_ENV` | permitem rodar qualquer modelo sem config por provedor |

> **`RECALL_MAX_STEPS` não é só um teto.** O teto quase nunca é atingido
> (`finishReason=stopped` em 30 de 30, mediana de 5 passos de 12). Mas a
> `BudgetPolicy` **deriva dele** a pressão de síntese:
> `encourageFrom = maxSteps - 9`. Com `maxSteps=12` o agente recebe "evite
> novas leituras" **a partir do passo 3**. Subir o teto é como se empurra esse
> aviso para mais tarde — foi o único ganho validado da investigação
> (`maxSteps=24`: +4,2pp de recall, e mais barato).

### Arquiteturas de revisão

Cada bloco abaixo é uma configuração distinta. Elas **se somam** ao generalista
a menos que você desligue o generalista explicitamente.

#### Generalista sozinho (a linha de base)

Não ligue nada. Uma passada ampla sobre o diff inteiro.

```bash
RECALL_REAL_REPO=1 RECALL_CALL_GRAPH=1 RECALL_MAX_STEPS=24 \
RECALL_REDUCER=1 RECALL_SKIP_VERIFY=1 RECALL_REASONING_EFFORT=low
```

> O generalista **sempre roda com o call graph** por decisão do projeto —
> produção já roda com ele, então medir sem é medir outra coisa.

#### Plan + Shard

```bash
RECALL_SELECTOR_SHARD=1
```

Plano do LLM → `grep` no repositório → uma passada por grupo de call sites
afetados. É a **única passada que lê código que o diff não contém**. Exige
`RECALL_REAL_REPO=1` (fixture gravada não responde busca por código ausente do
diff).

Knobs: `RECALL_SHARD_CAP=<n>` (sites por PR, default 6),
`RECALL_SHARD_PER_WORKER=<n>` (sites por worker),
`RECALL_SHARD_DEDICATED=1` (worker ganha prompt próprio em vez de herdar o do
generalista), `RECALL_SHARD_ALT=1`.

#### Graph Shard

```bash
RECALL_GRAPH_SHARD=1 RECALL_CALL_GRAPH=1
```

Mesma passada de shard, mas os sites vêm do **blast radius da AST** em vez de
plano do LLM + grep. Custa uma chamada de LLM a menos por PR e alcança
dependentes que o grep perde estruturalmente (`USES_TYPE`, `INHERITS`).

**Exige `RECALL_CALL_GRAPH=1`** — sem grafo não há sites, e a passada
silenciosamente não faz nada. `RECALL_GRAPH_DEPTH=<n>` controla a profundidade
(default 1).

Ligar `RECALL_GRAPH_SHARD` sozinho faz substituição (`graphSitesOnly`); ligar os
dois juntos mede o híbrido (grafo onde tem site, grep no resto).

#### Microagentes

```bash
RECALL_MICRO_AGENTS=1 RECALL_SKIP_BASE_PASS=1 RECALL_SKIP_SYNTHESIS=1
```

**14 passadas estreitas**, uma por classe de defeito, definidas em
`libs/code-review/infrastructure/agents/core/micro-agents.ts`. Cada agente
carrega 1 a 7 itens de detecção e **nada mais** — sem Workflow, sem
CoverageContract, sem as definições das outras treze classes. O prompt de
instrução tem ~1k tokens contra os ~21k do system prompt do generalista.

Os dois `SKIP` são o que torna isso um teste de "só os microagentes": sem eles o
generalista roda junto e você não sabe quem achou o quê.

`RECALL_MICRO_PLANNER=1` roteia antes — só as classes que o diff poderia conter
ganham passada. **Medido e pior**: recall caiu de 32,6% para 21,1%.

#### Scout / Investigator

```bash
RECALL_SCOUT_INVESTIGATOR=1
```

Um scout barato de uma tacada sinaliza pontos suspeitos, depois uma passada
completa por sinal investiga com orçamento de tool próprio.

Variações: `RECALL_SCOUT_CAP=<n>` (default 5; **`0` = sem teto**, então teste
presença e não veracidade), `RECALL_SCOUT_THINKING=1` (scout com reasoning
medium — independente de `RECALL_REASONING_EFFORT`, que controla o
investigador), `RECALL_SCOUT_BY_CATEGORY=1` (três scouts paralelos, um por
categoria), `RECALL_SCOUT_RESAMPLE=1` (3 rodadas), `RECALL_SCOUT_SECOND_ROUND=1`
(exatamente 2 rodadas), `RECALL_SCOUT_LINE_HINT=1`,
`RECALL_SCOUT_VERDICT=1` (scout roda primeiro e vira checklist obrigatório do
generalista), `RECALL_SCOUT_DEDICATED_PROMPT=1`,
`RECALL_SCOUT_CALIBRATED_PROMPT=1`, `RECALL_PARALLEL_SCOUT=1`.

`RECALL_HYPOTHESIS_DRIVEN=1` faz o scout nomear uma hipótese falsificável em vez
de um sinal vago. `RECALL_INVESTIGATOR_GROUP_BY_FILE=1` junta sinais do mesmo
arquivo numa passada só.

#### Painéis de papéis

| variável | o que faz |
|---|---|
| `RECALL_EXPERT_PANEL=1` | N passadas por papel (especialista da linguagem, segurança, performance, QA, DBA condicional) + uma passada de arbitragem |
| `RECALL_ROLE_ENSEMBLE=1` | versão enxuta: linguagem + segurança + performance, mesclados **sem** arbitragem |
| `RECALL_RECOGNITION_PANEL=1` | 4 papéis escolhidos por padrão de falha de reconhecimento, não por tópico (Contract Auditor, Data-Flow Tracer, Cross-Method Consistency Checker, Failure-Path Specialist) |
| `RECALL_EXPERT_PANEL_DEDICATED_PROMPT=1` | os três acima ganham base mínima só-diff |

#### Passadas por arquivo / por hunk

| variável | o que faz |
|---|---|
| `RECALL_CRITICAL_FILE_PASS=1` | uma passada de arquivo inteiro por arquivo de tier crítico |
| `RECALL_ATOMIC_FILES=1` | uma passada por arquivo alterado |
| `RECALL_ATOMIC_HUNKS=1` | uma passada por hunk de todo arquivo — a versão exaustiva |
| `RECALL_CRITICAL_FILE_DEDICATED_PROMPT=1` | base dedicada para essas passadas |
| `RECALL_CRITICAL_MAX_STEPS=<n>` | teto de passos só para elas |

> **Cuidado de regime.** Todas essas adicionam passadas. Não compare um run com
> elas contra um sem como se só a qualidade tivesse mudado — o custo mudou
> junto. Rotule o eixo.

#### Outras

| variável | o que faz |
|---|---|
| `RECALL_FREEFORM=1` | uma passada independente com prompt mínimo estilo dev sênior |
| `RECALL_ADVERSARIAL=1` | troca a tarefa de revisar pela tarefa de quebrar |
| `RECALL_SECOND_LOOK=1` | quando um investigador limpa o sinal após usar tool, uma passada de follow-up pergunta sobre um defeito **diferente** no mesmo arquivo |
| `RECALL_SECOND_LOOK_ALWAYS=1` | dispara o second look em toda passada que usou tool. Exige `RECALL_SECOND_LOOK=1` |
| `RECALL_SECOND_LOOK_FORCE_REPORT=1` | tira a saída "submeter vazio" do second look |
| `RECALL_CHALLENGE_DISMISSALS=1` | uma passada argumenta o contrário do próprio raciocínio anterior |

### Estágios finais

| variável | efeito |
|---|---|
| `RECALL_REDUCER=1` | **redutor**: uma passada sobre o conjunto inteiro de candidatos — mescla, descarta por mérito e ordena por importância. Substitui verify (por finding, cego ao resto) e dedup (conjunto todo, mas só pergunta "mesmo bug?") |
| `RECALL_SKIP_VERIFY=1` | tira o verify. Ele manteve 98,2% dos candidatos em 5 modelos, a uma chamada de LLM cada |
| `RECALL_SKIP_DEDUP=1` | tira dedup e redutor juntos |
| `RECALL_DEDUP_ROOT_CAUSE=1` | dedup por causa raiz |
| `RECALL_SKIP_SYNTHESIS=1` | tira a passada de synthesis-rescue |
| `RECALL_SKIP_BASE_PASS=1` | **pula o generalista inteiro**, sem chamada de LLM. Findings finais vêm só das passadas configuradas |

### `RECALL_CATEGORIES` — leia antes de comparar com produção

Os datasets fixam isso em `["bug"]` em 51 dos 53 casos. **Produção usa
bug + security + performance.**

A diferença não é cosmética: o `prompt-builder` renderiza "rode uma passada
explícita para cada categoria habilitada" e "anote pelo menos uma hipótese
concreta testada para cada uma". Com uma categoria só, essa varredura inteira
colapsa numa passada.

**Todo número desta investigação foi medido numa config mais estreita que a do
produto.** Para aproximar: `RECALL_CATEGORIES=bug,security,performance`.

---

## 5. Receitas prontas

As duas configurações medidas em 19/09/2026, já com o diff completo e o call
graph refeito. Copie e troque só o `--cases` e o `--output`.

### Plan + Shard

```bash
S=/tmp/bench && rm -rf $S/ps && \
RECALL_REAL_REPO=1 RECALL_CALL_GRAPH=1 RECALL_SELECTOR_SHARD=1 \
RECALL_MAX_STEPS=24 RECALL_REDUCER=1 RECALL_SKIP_VERIFY=1 \
RECALL_REASONING_EFFORT=low RECALL_CONCURRENCY=2 RECALL_DUMP=$S/ps \
node evals/investigation/run-recall.js --model gpt-5.6-sol@sub \
  --set light --output evals/investigation/results/ps-light.json
```

### 14 microagentes

```bash
S=/tmp/bench && rm -rf $S/m14 && \
RECALL_REAL_REPO=1 RECALL_CALL_GRAPH=1 \
RECALL_MICRO_AGENTS=1 RECALL_SKIP_BASE_PASS=1 RECALL_SKIP_SYNTHESIS=1 \
RECALL_MAX_STEPS=12 RECALL_REDUCER=1 RECALL_SKIP_VERIFY=1 \
RECALL_REASONING_EFFORT=low RECALL_CONCURRENCY=1 RECALL_DUMP=$S/m14 \
node evals/investigation/run-recall.js --model gpt-5.6-sol@sub \
  --set light --output evals/investigation/results/m14-light.json
```

> `RECALL_CONCURRENCY=1` nos microagentes é proposital: eles já disparam 14
> chamadas em paralelo por PR num `Promise.all`. Com concorrência 2 são 28
> simultâneas, e o provedor começa a devolver 429.

**Nunca rode as duas configurações ao mesmo tempo.** Somadas passam de 20
chamadas simultâneas. Encadeie num script com `nohup`.

---

## 6. O corpus — o que você precisa saber antes de confiar num número

### O diff era truncado até 19/09/2026

Os datasets foram extraídos com `maxFiles: 6` e `includeTests: false`, e **nada
registrava o que foi cortado** — `omittedFilePaths` está vazio até num PR onde
141 de 142 arquivos foram descartados. No conjunto light isso deixava 138
arquivos nos datasets contra 757 nos PRs reais.

A correção mora em `vars.changedFilesFull`, escrito por:

```bash
node evals/investigation/materialize-full-diff.js --set=light
```

Ele usa a cadeia exata de produção (`handlePatchDeletions` →
`convertToUnifiedDiffWithLineNumbers`) e grava num campo **novo**, não por cima
do `changedFiles`. Os dois convivem de propósito: assim a visão de 6 arquivos e
a visão completa são um A/B no mesmo corpus, em vez de uma migração que invalida
todo número anterior.

O `agent-provider.js` prefere `changedFilesFull` quando existe.

### O call graph também estava velho

Pelo mesmo motivo: era construído sobre a lista truncada. Num PR de 127 arquivos
ele cobria **1**. Corrigido em 19/09/2026; para regerar:

```bash
node evals/investigation/build-call-graphs.js --set=light
```

Ele lê os arquivos do **clone** no commit de head (não do `toolReplay`) e grava
em `vars.callGraphJson` dentro dos datasets. Precisa do kodus-graph:
`KODUS_GRAPH_CLI=/caminho/para/kodus-graph/dist/cli.js` (default: checkout irmão).

Efeito da regeração: `frontend-asset-optimization` foi de 6 nós para 1.945, com
3.395 arestas entre arquivos onde antes eram ~0. 23% dos 757 arquivos mudaram de
tier.

Use `--dry-run` para ver o resultado sem gravar.

### Clones

`prepare-repo.js` cuida deles; ficam em `BENCH_REPOS_ROOT` (default `~/.kodus-bench-repos`).
O `RECALL_REAL_REPO=1` prepara o worktree no commit certo automaticamente.

> Se o VS Code parar de mostrar arquivos alterados no repo principal depois de
> mexer com worktree, confira `git config core.bare` — já aconteceu de ficar
> `true`.

---

## 7. Piso de ruído — não persiga diferença pequena

**±0,026 de F1 e ±1pp de recall**, medido em quatro runs que por acidente
tinham config idêntica.

Nos 30 PRs são 95 goldens, então **1 golden ≈ 1,05pp de recall**. Num
subconjunto de 5 PRs (17 goldens) **1 golden vale 5,9pp** — a granularidade
sozinha é 6x o piso de ruído. Rodada de 5 PRs serve para ver custo e detectar
quebra, não para decidir arquitetura.

---

## 8. Armadilhas que já custaram runs inteiros

**O adaptador monta os params campo a campo.** `core-agent-loop.adapter.ts`
constrói o objeto do finder listando cada campo. Qualquer parâmetro adicionado
ao finder e **não listado ali é descartado em silêncio**. Quatro runs de 30 PRs
se reportaram como experimentos de graph-shard e teto elevado enquanto rodavam o
default de plan+grep — ~55M de tokens medindo a mesma coisa. Se um experimento
novo devolver número idêntico ao baseline, **suspeite disso primeiro**. Declarar
o campo em `AgentLoopInput` faz o `tsc` pegar.

**Confira a passada no dump antes de confiar no run.** `shardPlan: null` quando
deveria ter plano significa que o shard não rodou. O debugger mostra as passadas
executadas por nome.

**Prompt de experimento abandonado fica no código.** Um teste com prompt
alternativo que saiu pior deixou o prompt lá, e os dois runs seguintes partiram
de uma base sabidamente ruim. Reverta o prompt junto com a conclusão, e registre
o resultado no comentário da função.

**Quota do `@sub` acaba no meio do run.** O sintoma no `.json` é
`finishReason=completed, steps=0, tokens=0` marcado como `infra`; no log aparece
`AI_APICallError: The usage limit has been reached`. Os casos afetados **não são
sorteados** — são os do fim da fila, então o agregado fica enviesado. Sempre
confira `infraFailures` no topo do `.json` antes de ler as métricas.

**Chave de golden é sensível à ordem das operações.** Um `trim()` antes em vez
de depois do `slice(0,55)` fez goldens perdidos parecerem encontrados. O número
de "nunca encontrados" pulou de 40 para 48 quando corrigido.

---

## 9. Onde as coisas moram

| caminho | o quê |
|---|---|
| `evals/investigation/run-recall.js` | entrada do run |
| `evals/investigation/agent-provider.js` | onde as env vars viram configuração do loop |
| `evals/investigation/recall-tests.js` | definição dos conjuntos (`LIGHT_CASES` etc) |
| `evals/investigation/datasets/*.json` | os PRs: diff, goldens, call graph, toolReplay |
| `evals/investigation/materialize-full-diff.js` | grava o diff completo |
| `evals/investigation/build-call-graphs.js` | grava o call graph do corpus |
| `evals/investigation/build-pr-callgraph.js` | monta o `<CallGraph>` do prompt em tempo de run |
| `evals/investigation/build-trace-debugger.js` | monta a página de trace (ver `instructions-trace-debugger.md`) |
| `evals/investigation/langfuse-traces.js` | resolve os traces via API |
| `evals/investigation/eval-observability.js` | a porta `LlmObservability` do eval |
| `libs/code-review/infrastructure/agents/core/micro-agents.ts` | os 14 microagentes |
| `libs/code-review/infrastructure/agents/core/selector-shard.ts` | plan/graph shard |
| `libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts` | adaptador — **o dos params campo a campo** |
| `libs/common/utils/codeReview/v2Defaults.ts` | os 34 itens de detecção |

---

## 10. Estado em 19/09/2026

**Validado:** `maxSteps=24` é o único ganho confirmado nos 30 PRs (+4,2pp de
recall, e mais barato). A regeração do call graph melhorou o plan+shard nas
quatro métricas ao mesmo tempo, num subconjunto de 5.

**Aberto:** os 14 microagentes rodaram em 21 dos 30 PRs (a quota acabou) —
recall 48,6%, precision 27,0%, F1 0,347, 49,8M de tokens. Recall alto, precision
pela metade do campeão, custo alto e concentrado nos PRs de diff grande. Faltam
9 PRs, e eles não são aleatórios.

**Não medido:** o plan+shard nos mesmos 21 PRs. Sem isso não há comparação
pareada.

**Pendências conhecidas:**

- Os 5 itens estendidos vivem como constantes no `micro-agents.ts` e **não** no `v2Defaults.ts`. Portar dá acesso a eles também ao generalista, ao shard e ao scout — e muda o campeão, então é um experimento, não uma arrumação.
- `formatDiffs(input.changedFiles)` nunca recebe `fileTiers` nas três chamadas (`prompt-builder.ts:354`, `:507`, `:633`). A redução de `optional` para cabeçalhos de hunk é código morto **também em produção**. O tier ainda serve como portão de conclusão e rótulo de cobertura, só não corta prompt.
- O eval chama `runAgentLoopViaCore` direto, pulando o `BaseCodeReviewAgentProvider`. O tiering ele replica de propósito; o filtro low-signal e o **batching** não. Um PR que em produção viraria 33 batches roda aqui numa passada só.
