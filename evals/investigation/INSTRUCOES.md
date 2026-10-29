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
node evals/investigation/run-recall-1821.js --model <modelo> --cases <ids> --output <arquivo.json>
```

O harness de pesquisa é o `*-1821.js` (`run-recall-1821.js`,
`agent-provider-1821.js`, `recall-tests-1821.js`). Os nomes sem sufixo são o
harness de produção da main, que não lê as `RECALL_*` de arquitetura abaixo.

O que ele roda por PR: o generalista (passada base) → synthesis-rescue → verify
(com o evidence gate) → descarte do parse schema → dedup no mesmo modelo.
`trace.preFilterCandidates` é o snapshot depois do verify e antes do dedup.

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

Registrado no topo do `agent-provider-1821.js`, **depois** do `dotenv` e nunca antes.

```
LANGFUSE_TRACING=true
LANGFUSE_PUBLIC_KEY=<...>
LANGFUSE_SECRET_KEY=<...>
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
LANGFUSE_ENVIRONMENT=benchmark
```

As chaves vêm do `.env` e depois do `.env.local` com `override: true` — o
`.env.local` ganha. O ambiente é forçado para `benchmark` quando não vier
definido, justamente para os traces de bancada não se
misturarem com os de produção no mesmo projeto.

No começo do run o harness imprime uma linha dizendo se o tracing subiu:

```
[langfuse] tracing ON · env=benchmark · https://us.cloud.langfuse.com
```

Se aparecer `OFF`, ela diz qual chave está faltando. Trace ligado exige as três
coisas: `LANGFUSE_TRACING=true` **e** as duas chaves.

### Como os traces se chamam

Cada PR vira traces chamados `bench:<caseId>`, mais irmãos com sufixo
(ex.: `bench:<caseId>-recovery`). **Um run não produz um trace por PR**:
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

#### Generalista sozinho (a linha de base)

Não ligue nada. Uma passada ampla sobre o diff inteiro.

```bash
RECALL_REAL_REPO=1 RECALL_CALL_GRAPH=1 RECALL_MAX_STEPS=24 \
RECALL_REASONING_EFFORT=low
```

> O generalista **sempre roda com o call graph** por decisão do projeto —
> produção já roda com ele, então medir sem é medir outra coisa.

### Estágios finais

| variável | efeito |
|---|---|
| `RECALL_SKIP_DEDUP=1` | tira o dedup |
| `RECALL_DEDUP_ROOT_CAUSE=1` | dedup por causa raiz |
| `RECALL_SKIP_SYNTHESIS=1` | tira a passada de synthesis-rescue |
| `RECALL_GATE=1` | além do gate de piso, liga o gate da prova depois do dedup (experimento) |

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

## 5. O corpus — o que você precisa saber antes de confiar num número

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

## 6. Piso de ruído — não persiga diferença pequena

**±0,026 de F1 e ±1pp de recall**, medido em quatro runs que por acidente
tinham config idêntica.

Nos 30 PRs são 95 goldens, então **1 golden ≈ 1,05pp de recall**. Num
subconjunto de 5 PRs (17 goldens) **1 golden vale 5,9pp** — a granularidade
sozinha é 6x o piso de ruído. Rodada de 5 PRs serve para ver custo e detectar
quebra, não para decidir arquitetura.

---

## 7. Armadilhas que já custaram runs inteiros

**O adaptador monta os params campo a campo.** `core-agent-loop.adapter.ts`
constrói o objeto do finder listando cada campo. Qualquer parâmetro adicionado
ao finder e **não listado ali é descartado em silêncio**. Quatro runs de 30 PRs
se reportaram como experimentos de graph-shard e teto elevado (modos já
removidos) enquanto rodavam o default de plan+grep — ~55M de tokens medindo a mesma coisa. Se um experimento
novo devolver número idêntico ao baseline, **suspeite disso primeiro**. Declarar
o campo em `AgentLoopInput` faz o `tsc` pegar.

**Confira as passadas no dump antes de confiar no run.** `trace.recallPasses`
lista as passadas que rodaram (a base e, sem `RECALL_SKIP_SYNTHESIS=1`, a
synthesis-rescue). O debugger
mostra as passadas executadas por nome.

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

## 8. Onde as coisas moram

| caminho | o quê |
|---|---|
| `evals/investigation/run-recall-1821.js` | entrada do run de pesquisa |
| `evals/investigation/agent-provider-1821.js` | onde as env vars viram configuração do loop, e o dedup |
| `evals/investigation/recall-tests-1821.js` | definição dos conjuntos (`LIGHT_CASES` etc) |
| `evals/investigation/protocolo.sh` | a rodada padrão (ver `instructions-eval.md`) |
| `evals/investigation/datasets/*.json` | os PRs: diff, goldens, call graph, toolReplay |
| `evals/investigation/materialize-full-diff.js` | grava o diff completo |
| `evals/investigation/build-call-graphs.js` | grava o call graph do corpus |
| `evals/investigation/build-pr-callgraph.js` | monta o `<CallGraph>` do prompt em tempo de run |
| `evals/investigation/build-trace-debugger.js` | monta a página de trace (ver `instructions-trace-debugger.md`) |
| `evals/investigation/langfuse-traces.js` | resolve os traces via API |
| `evals/investigation/eval-observability.js` | a porta `LlmObservability` do eval |
| `libs/code-review/infrastructure/agents/core/finder.agent.ts` | passada base, synthesis-rescue e verify |
| `libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts` | adaptador — **o dos params campo a campo** |
| `libs/common/utils/codeReview/v2Defaults.ts` | os 34 itens de detecção |

---

## 9. Estado em 19/09/2026 (histórico)

Microagentes, plan/graph shard e scout citados aqui **não existem mais** — foram
removidos do `libs/` e do harness. O que segue é registro do que foi medido.

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

- Os 5 itens estendidos viviam como constantes no `micro-agents.ts` (removido) e nunca chegaram ao `v2Defaults.ts`.
- `formatDiffs(input.changedFiles)` nunca recebe `fileTiers` nas três chamadas (`prompt-builder.ts:354`, `:507`, `:633`). A redução de `optional` para cabeçalhos de hunk é código morto **também em produção**. O tier ainda serve como portão de conclusão e rótulo de cobertura, só não corta prompt.
- O eval chama `runAgentLoopViaCore` direto, pulando o `BaseCodeReviewAgentProvider`. O tiering ele replica de propósito; o filtro low-signal e o **batching** não. Um PR que em produção viraria 33 batches roda aqui numa passada só.
