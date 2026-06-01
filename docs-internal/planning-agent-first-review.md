# Plano: Code Review Agent-First

## Problema

Benchmark offline (50 PRs normais, pipeline completo): **13.8% precision, 46.7% recall, 21.3% F1**.
A precision é a pior entre todos os tools. O recall é razoável — encontramos issues reais, mas enterramos em ruído.

**Causa raiz**: a geração standard é single-shot (1 LLM call por arquivo, sem tools, sem investigação). Gera muito → filtra depois via safeguard pesado. Os concorrentes top (Qodo v2, Augment, CodeAnt) usam agentes que investigam antes de sugerir.

## Proposta

Substituir a geração standard por **agentes com tools** que investigam antes de sugerir. Kody Rules (file e PR) mantêm como hoje — o problema não é lá.

---

## Arquitetura Nova

```
  Changed Files + Config + Memories
                    ↓
          ┌───────────────────┐
          │   Orchestrator     │
          │                    │
          │ Recebe arquivos +  │
          │ config + review    │
          │ options            │
          └────────┬───────────┘
                   │
          Checa review options:
          só dispara agentes
          cujas categorias
          estão ligadas
                   │
           ┌───────┼───────┐
           ↓       ↓       ↓
     ┌──────────┐┌──────────┐┌──────────┐
     │ Agente   ││ Agente   ││ Agente   │
     │ Bugs/    ││ Security ││ Perf     │
     │ Lógica   ││          ││          │
     └────┬─────┘└────┬─────┘└────┬─────┘
          │           │           │
       Tools:      Tools:     Tools:
       grep        grep       grep
       readFile    readFile   readFile
       listDir     listDir    listDir
       astGrep     astGrep    astGrep
       shell       shell      shell
       searchDocs  searchDocs searchDocs
          │           │           │
          ↓           ↓           ↓
       Findings    Findings    Findings
       com evid.   com evid.   com evid.
          └──────┬─┴───────┬───┘
                    ↓
         ┌─────────────────────┐
         │ Kody Rules          │
         │ (mantém como hoje)  │
         │ - Rules file-level  │
         │ - Rules PR-level    │
         │ - Business Logic    │
         └──────────┬──────────┘
                    ↓
         ┌─────────────────────┐
         │ Merge + Dedup       │
         │ + Safeguard         │
         │ (mantém como hoje)  │
         └──────────┬──────────┘
                    ↓
         ┌─────────────────────┐
         │ Filtros do Cliente  │
         │ - Severity level    │
         │ - Quantity limits   │
         │ - Review options    │
         └──────────┬──────────┘
                    ↓
         ┌─────────────────────┐
         │ Morph / Committable │
         │ (mantém como hoje)  │
         └──────────┬──────────┘
                    ↓
             5-8 suggestions
```

---

## Agentes

### Agente de Bugs/Lógica


|                   |                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Foco**          | Bugs, edge cases, error handling, data flow, race conditions                                  |
| **Input**         | Diffs completos de todos os arquivos. Memory rules como contexto.                             |
| **Comportamento** | Olha mapa → prioriza arquivos com lógica core → investiga com tools → só sugere com evidência |
| **Tools**         | grep, readFile, listDir, astGrep, shell (linters), searchDocs                                 |
| **Output**        | Findings com evidência (sem limite fixo — filtros do cliente cortam depois)                    |
| **Modelo**        | Forte (Pro/Opus) — precisa raciocinar                                                         |


### Agente de Security


|                   |                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| **Foco**          | Vulnerabilidades, auth, injection, data exposure, secrets                                               |
| **Input**         | Mesmo do agente de bugs                                                                                 |
| **Comportamento** | Foca em patterns de segurança → verifica sanitização, auth flows → usa astGrep pra patterns estruturais |
| **Tools**         | grep, readFile, listDir, astGrep, shell, searchDocs                                                     |
| **Output**        | Findings com evidência (sem limite fixo)                                                                |
| **Modelo**        | Forte (Pro/Opus)                                                                                        |


### Agente de Performance


|                   |                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| **Foco**          | N+1 queries, loops desnecessários, memory leaks, allocations em hot paths, caching                      |
| **Input**         | Mesmo do agente de bugs                                                                                 |
| **Comportamento** | Identifica patterns de performance → investiga com tools pra confirmar impacto → só sugere se relevante |
| **Tools**         | grep, readFile, listDir, astGrep, shell, searchDocs                                                     |
| **Output**        | Findings com evidência (sem limite fixo)                                                                |
| **Modelo**        | Forte (Pro/Opus)                                                                                        |


### Orchestrator


|                   |                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Foco**          | Distribuir trabalho e gerenciar fluxo                                                                                           |
| **Comportamento** | 1. Recebe arquivos + config + review options. 2. Checa quais categorias estão ligadas. 3. Dispara só os agentes relevantes em paralelo (diffs completos). 4. Coleta resultados. |


---

## Infra: Agent Loop Padronizado

### Problema hoje

Existem dois agent loops no codebase com patterns completamente diferentes:

1. **ConversationAgent** (`libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts`): usa `@kodus/flow` com `SDKOrchestrator`, ReAct planner, MCP adapter, thread/memory. Mais robusto.

2. **Safeguard Agent** (`libs/code-review/infrastructure/adapters/services/safeguardPipeline.service.ts`): loop manual (`for turn < MAX_TURNS`), parse de JSON na mão, tools hardcoded, conversa montada como array de messages. Funcional mas frágil.

### Decisão

Padronizar em `@kodus/flow`. Já tem: agent loop, ReAct planner, tools registration, observability, BYOK. Não faz sentido manter dois patterns.

### O que criar

Usar `BaseAgentProvider` como base. Cada agente novo (bugs, security, performance) herda e define apenas:

- **Prompt** (system + identity)
- **Tools permitidas** (subset do pool: grep, readFile, listDir, astGrep, shell, searchDocs)
- **Output schema** (formato das suggestions)
- **Max turns / limites**

O loop, planner, BYOK, observability, sandbox management — tudo vem do framework.

### Requisitos obrigatórios

Os agentes novos **devem** respeitar tudo que o pipeline atual já respeita:

- **BYOK**: usar `BYOKPromptRunnerService` como hoje. Cliente com chave própria usa o provider dele, senão usa o default. `BaseAgentProvider` já faz isso via `fetchBYOKConfig()`. O campo `executeMode` (`'byok'` | `'system'`) vai nos metadata dos spans pra saber se usou chave do cliente.
- **Self-hosted**: funcionar sem depender de serviços externos que não existem em self-hosted (ex: se E2B não disponível, fallback sem sandbox).
- **Token tracking**: todas as LLM calls dos agentes devem passar pelo `observabilityService.runLLMInSpan()`. Ele captura por span: `gen_ai.usage.total_tokens`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `response.model`, `run.id`, `run.name`. Gravado em MongoDB com batch flush (75 items / 3s). O `BaseAgentProvider.createLLMAdapter()` já faz isso.
- **Logs estruturados**: usar `createLogger` do `@kodus/flow`. Pattern obrigatório: `{ message, context: ClassName.name, metadata: { correlationId, organizationId, teamId, prNumber, ... } }`.
- **Logs de pipeline**: o `PipelineExecutor` já loga início/fim de cada stage com duração em ms e grava métricas via `metricsCollector.recordHistogram('pipeline_stage_duration_ms', ...)`. O `AgentReviewStage` novo deve funcionar igual.
- **Logs de agent**: seguir o pattern de tags do safeguard pra facilitar filtro:
  - `[TIMING]` — duração de cada step e totais
  - `[AGENT-TOOL]` — cada tool call com `turn`, `tool`, `path/pattern`, `resultLength`
  - `[AGENT]` — status geral do agente (início, fim, suggestions geradas)
- **Automation execution**: status do pipeline (`AutomationStatus`: PENDING → IN_PROGRESS → SUCCESS/ERROR/PARTIAL_ERROR/SKIPPED) deve continuar atualizado. Referência: `AutomationStatus` enum + `statusInfo` no context.
- **Custom prompts**: os agentes devem respeitar as customizações do cliente:
  - `languageResultPrompt`: idioma do resultado (ex: "pt-BR", "en-US"). Vai no prompt do agente pra ele responder no idioma configurado.
  - `v2PromptOverrides`: cada agente recebe os overrides relevantes no prompt:
    - `categories.descriptions` — descrição customizada por categoria (bug, performance, security). Cada agente recebe o override da sua categoria.
    - `severity.flags` — flags por severidade (critical, high, medium, low). Todos os agentes recebem.
    - `generation.main` — instrução base de como escrever suggestions (tom, formato, estilo). Default: "Detailed and verifiable issue description" com regras de brevidade, voz ativa, sem filler. Customizável pelo cliente. **Todos os agentes devem respeitar.** Referência: `default-kodus-config.yml` e `CodeReviewConfig.v2PromptOverrides` em `libs/core/infrastructure/config/types/general/codeReview.type.ts`.

### Referências

- Base: `libs/agents/infrastructure/services/kodus-flow/base-agent.provider.ts`
- Exemplo: `libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts`
- Framework: `@kodus/flow` (createOrchestration, SDKOrchestrator, PlannerType.REACT)

---

## Tools do Agente


| Tool         | Params                                | Função                                 | Existe?                                             |
| ------------ | ------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| `grep`       | `pattern`, `glob?`, `path?`, `limit?` | Busca regex no codebase via sandbox    | Sim (safeguard tem `search`) — adicionar glob/limit |
| `readFile`   | `path`, `startLine?`, `endLine?`      | Lê arquivo com ranges                  | Sim (safeguard tem `read`) — adicionar ranges       |
| `listDir`    | `path`                                | Lista diretório                        | Sim (safeguard tem `list`)                          |
| `astGrep`    | `pattern`, `lang`, `path?`            | Busca estrutural via ast-grep CLI      | **Novo** — instalar ast-grep no sandbox             |
| `searchDocs` | `package`, `function?`                | Busca docs externas via Exa            | **Novo** — reutilizar GatherDocumentationCtx        |
| `shell`      | `command`                             | Roda comandos read-only (linters, tsc) | **Novo** — whitelist de comandos                    |


---

## O que muda no pipeline

### Stages que são REMOVIDOS


| Stage                           | Substituído por                                    |
| ------------------------------- | -------------------------------------------------- |
| **6. GatherDocumentationCtx**   | Tool `searchDocs` — agente busca quando precisa    |
| **10. CollectCrossFileContext** | Tools `grep`/`readFile` — agente busca sob demanda |


### Stages que são REESCRITOS


| Stage                      | Mudança                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| **12. ProcessFilesReview** | Substituído por `AgentReviewStage` — orchestrator + agentes com tools. Sem file-by-file. |


### Stages que são SIMPLIFICADOS


| Stage                    | Mudança                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| **14. AggregateResults** | Merge outputs dos agentes + results do stage 11 (rules/business logic) |


### Stages que MANTÊM como hoje


| Stage                             | Por que mantém                                                 |
| --------------------------------- | -------------------------------------------------------------- |
| **1-5**                           | Setup, validation, config, fetch files — não muda              |
| **7-8**                           | LoadExternalContext, FileContextGate — vira contexto do agente |
| **9**                             | InitialComment                                                 |
| **11. ProcessFilesPrLevelReview** | Kody Rules PR + Business Logic — mantém                        |
| **13. ValidateSuggestions**       | Morph/committable — mantém                                     |
| **15-18**                         | Comments, summary, approve — mantém                            |


### Novo stage: CreateSandbox

Sandbox E2B precisa ser criado antes dos agentes (hoje é criado no CollectCrossFileContext):

```
9.  InitialComment
10. CreateSandboxStage (novo) → cria sandbox, guarda handle no context
11. ProcessFilesPrLevelReview (mantém — rules + business logic)
12. AgentReviewStage (novo) → orchestrator + agentes com tools
13. ValidateSuggestions (morph)
...
```

### Kody Rules: onde ficam no novo fluxo

**Não mudam.** Continuam nos mesmos stages/services de hoje:

- **Rules file-level**: continuam no `ProcessFilesReview` / `CodeAnalysisOrchestrator` — mas agora rodam sobre os results dos agentes, não do single-shot LLM
- **Rules PR-level**: continuam no `ProcessFilesPrLevelReview` (stage 11)
- **Memory rules**: vão no system prompt dos agentes como contexto
- **Business Logic**: continua no stage 11

A única mudança é que as **standard suggestions** que os rules recebem como input (`standardSuggestions` no `executeKodyRulesAnalysis`) agora vêm dos agentes ao invés do single-shot LLM.

---

## Pós-Geração: Safeguard + Filtros

Depois que agentes geram suggestions, passa pelas mesmas camadas de hoje:

```
Agentes → Merge + Dedup (já existe) → Safeguard (mantém como hoje) → Filtros do Cliente → Morph → Output
```

### Merge + Dedup

O pipeline atual já faz merge e dedup, mas precisa de uma adição pra lidar com múltiplos agentes:

**Já existe (mantém):**
- `removeSuggestionsRelatedToSavedFiles`: remove suggestions de arquivos que já têm suggestions salvas
- Merge: junta suggestions de diferentes fontes (standard, kody rules, AST) com dedup por arquivo
- Clustering por Kody Rule ID: agrupa suggestions que quebraram a mesma rule

**Novo — dedup cross-agent por localização:**
- Hoje o clustering é só por Rule ID — não detecta quando dois agentes apontam pro mesmo trecho de código
- Com 3 agentes em paralelo, bugs e security podem achar o mesmo problema (ex: input não sanitizado é bug e é vuln)
- Dedup por **arquivo + range de linhas**: se dois agentes geram suggestion pro mesmo trecho, mantém o de maior severidade
- Determinístico, sem LLM

Referência: `libs/code-review/infrastructure/adapters/services/suggestion.service.ts`

### Safeguard (mantém como hoje)

O safeguard atual continua intacto: feature extraction → triage determinístico → agent verification com sandbox.

A mudança é só na geração — os agentes produzem suggestions com mais contexto e evidência, mas o safeguard continua validando como hoje. Não vale o risco de mexer nele agora.

Referência: `libs/code-review/infrastructure/adapters/services/safeguardPipeline.service.ts`

### Filtros do Cliente (mantém como hoje)

Configuração do cliente — o time decide o que quer receber. Mantêm intactos.

**Severity level filter** (`filterSuggestionsBySeverityLevel`):

- Cliente configura severidade mínima (critical, high, medium, low)
- Suggestions abaixo do threshold são descartadas

**Quantity limits** (`prioritizeSuggestionsBySeverityLimits`):

- Cliente configura limites por severidade (ex: max 3 critical, 5 high, 2 medium)
- Quando limit=0 → unlimited, quando limit>0 → capped

**Review options filter** (`filterCodeSuggestionsByReviewOptions`):

- Cliente escolhe quais categorias quer (bugs, security, performance, etc.)
- Suggestions fora das categorias selecionadas são removidas
- **cross_file deixa de ser categoria** — com agentes que têm tools (grep, readFile), todo agente naturalmente investiga outros arquivos quando precisa. Cross-file vira uma capacidade dos agentes, não uma categoria de suggestion. O orchestrator não precisa checar `cross_file` nos review options.

Referência: `libs/code-review/infrastructure/adapters/services/suggestion.service.ts`

---

## Rollout

### Feature flag

- Config: `codeReviewVersion: 'v3-agent'` (ou similar)
- Default: versão atual
- Permite ativar por repo/org
- Pipeline antigo continua funcionando

### Sequência de implementação

```
1. Infra base
   ├─ CreateSandboxStage (separar criação do sandbox)
   ├─ Tools como adapters pro @kodus/flow (grep, readFile, listDir, astGrep, shell, searchDocs)
   ├─ Base agent provider pra code review (herda BaseAgentProvider, configura sandbox + tools)
   └─ Feature flag na config

2. Agentes
   ├─ Agente de Bugs/Lógica (primeiro — é o core)
   ├─ Agente de Security
   └─ Agente de Performance

3. Orchestrator
   ├─ Passa diffs completos pros agentes
   ├─ Dispara agentes em paralelo
   └─ Merge dos outputs com rules (stage 11) — dedup já existe no pipeline

4. Integração
   ├─ Conectar no pipeline (substituir stages 6, 10, 12)
   ├─ Manter rules como hoje (stages 11, 12 pra rules)
   ├─ Manter filtros do cliente (severity, quantity, review options)
   ├─ Manter morph/committable (stage 13)
   └─ Ajustar aggregate (stage 14)

6. Validação
   ├─ Benchmark comparativo (agent vs pipeline antigo)
   ├─ A/B test em repos reais
   └─ Monitorar precision, recall, latência, custo
```

---

## Riscos


| Risco                                              | Mitigação                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Latência** — agentes multi-turn são mais lentos  | Max turns (10-15). Agentes em paralelo.                                                      |
| **Custo** — mais tokens por PR                     | Comparar custo total: agentes vs (analysis + safeguard + rules). Safeguard pesado já é caro. |
| **Sandbox timeout**                                | Reutilizar `tryRenewSandbox` do safeguard.                                                   |
| **Recall drop** — agente focado pode perder issues | Self-reflection como safety net. Benchmark contínuo.                                         |
| **Regressão**                                      | Feature flag. A/B test. Pipeline antigo como fallback.                                       |
| **PRs grandes** (100+ arquivos)                    | Limitar por token budget ou dividir em batches de arquivos entre agentes.                     |


---

## Métricas de Sucesso


| Métrica        | Atual    | Target          |
| -------------- | -------- | --------------- |
| Precision      | 13.8%    | 45%+            |
| Recall         | 46.7%    | 50%+            |
| F1             | 21.3%    | 47%+            |
| Suggestions/PR | ~20-30   | ~5-8            |
| Latência       | baseline | ≤ 2x baseline   |
| Custo/PR       | baseline | ≤ 1.5x baseline |


---

## Referências

### Docs

- Arquitetura detalhada: `docs/architecture-review-agent-first.md`

### Pipeline

- Pipeline strategy: `libs/code-review/pipeline/strategy/code-review-pipeline.strategy.ts`
- Pipeline context: `libs/code-review/pipeline/context/code-review-pipeline.context.ts`

### Stages a modificar/remover

- ProcessFilesReview: `libs/code-review/pipeline/stages/process-files-review.stage.ts`
- CollectCrossFileContext: `libs/code-review/pipeline/stages/collect-cross-file-context.stage.ts`
- GatherDocumentationCtx: `libs/code-review/pipeline/stages/gather-documentation-context.stage.ts`
- AggregateResults: `libs/code-review/pipeline/stages/aggregate-result.stage.ts`

### Stages que mantêm

- ProcessFilesPrLevelReview: `libs/code-review/pipeline/stages/process-files-pr-level-review.stage.ts`
- ValidateSuggestions: `libs/code-review/pipeline/stages/validate-suggestions.stage.ts`

### Agent infra (base pra novos agentes)

- BaseAgentProvider: `libs/agents/infrastructure/services/kodus-flow/base-agent.provider.ts`
- ConversationAgent (referência): `libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts`
- Framework: `@kodus/flow` (createOrchestration, SDKOrchestrator, PlannerType.REACT)

### Services (referência pra reutilizar)

- Safeguard (tools no sandbox — reutilizar RemoteCommands): `libs/code-review/infrastructure/adapters/services/safeguardPipeline.service.ts`
- LLM Analysis (substituir): `libs/code-review/infrastructure/adapters/services/llmAnalysis.service.ts`
- Suggestion Service (filtros + ranking): `libs/code-review/infrastructure/adapters/services/suggestion.service.ts`
- Cross-file Context: `libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service.ts`

### Kody Rules (mantém)

- Interface: `libs/kodyRules/domain/interfaces/kodyRules.interface.ts`
- File analysis: `libs/ee/codeBase/kodyRulesAnalysis.service.ts`
- PR analysis: `libs/ee/codeBase/kodyRulesPrLevelAnalysis.service.ts`
- Validation: `libs/ee/kodyRules/service/kody-rules-validation.service.ts`

