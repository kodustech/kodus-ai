# Kodus Skills Framework — Design Document

## 1. Problema

AI faz times de engenharia serem mais rapidos, mas **nao melhores**.
Incidentes por PR subiram 23.5%. Change failure rates subiram 30%.
Code review superficial nao pega desalinhamento entre codigo e requirements.

O dev abre PR, o reviewer humano demora horas, olha por cima, e nao valida se o codigo de fato atende o que a task pedia. Skills diferentes de cada reviewer criam inconsistencia.

O manager quer: qualidade minima garantida, regras customizadas por time, visibilidade do que acontece, e menos retrabalho.

---

## 2. Visao de Produto

**"O Kody aprende seu time."**

O Kodus Skills Framework e um sistema onde:

1. **Skills sao artefatos versionados** — arquivos declarativos (SKILL.md) que definem o que o Kody analisa, quais ferramentas usa, e quais regras segue
2. **Skills declaram capabilities abstratas** — "preciso ler contexto de task" em vez de "chama getJiraIssue" — o runtime resolve pro provider certo
3. **O sistema aprende** — apos execucoes bem-sucedidas, promove a tool que funciona melhor pra cada time/provider
4. **O manager configura e observa** — habilita skills por time, define regras custom, ve metricas de qualidade
5. **Parceiros podem criar skills** — usando SKILL.md + codigo leve, sem reescrever o framework

### Quem usa

| Persona | O que faz | O que ve |
|---------|-----------|---------|
| **Dev** | Abre PR, recebe feedback automatico | Analise de gaps entre codigo e task, sugestoes com evidencias |
| **Tech Lead** | Configura regras por time | Quais skills rodam, o que pegam, metricas de qualidade |
| **Parceiro** | Cria skill custom | Template SKILL.md + docs + API de capabilities |

### O que diferencia o Kodus

| Concorrente | O que faz | O que falta |
|-------------|-----------|-------------|
| CodeRabbit | Aprende de feedback aceito/rejeitado | Nao tem skills composiveis, nao resolve tools dinamicamente |
| Cursor | SKILL.md + Memories | IDE-centrico, nao faz code review com governance |
| Qodo | Multi-repo, padrao enforced | Nao tem learning loop por provider |
| Sourcery | Style guides por time | Nao conecta com task management |

**Gap de mercado:** ninguem combina capabilities abstratas + resolucao dinamica de MCP tools + learning por time + governance de manager.

---

## 3. Principios de Design

### 3.1 Skills como artefatos versionados

Seguindo o padrao aberto Agent Skills (agentskills.io), cada skill e um diretorio:

```
skill-name/
├── SKILL.md              # Frontmatter YAML + instrucoes markdown
├── references/           # Docs carregados sob demanda
├── scripts/              # Automacoes executaveis
├── assets/               # Templates, schemas
└── evals/                # Casos de teste (trajectory + outcome)
```

### 3.2 Progressive disclosure (3 tiers)

| Tier | Quando carrega | O que carrega | Tokens |
|------|---------------|--------------|--------|
| Discovery | Startup | `name` + `description` | ~100 |
| Invocation | Skill ativada | SKILL.md body | <5000 |
| Execution | Sob demanda | references/, scripts/, assets/ | variavel |

**Por que importa:** com 10+ skills instaladas, carregar tudo no context window degrada qualidade. Progressive disclosure mantem o contexto limpo.

### 3.3 Capabilities como building blocks

Uma capability e uma abstracao reutilizavel:

```
Capability                 O que faz                          Reutilizavel por
------------------------  --------------------------------   ----------------
task.context.read         Busca contexto de task (Jira, etc)  Qualquer skill que precise de task context
pr.diff.read              Busca diff do PR                    Qualquer skill que analise codigo
pr.metadata.read          Busca metadata do PR                Qualquer skill sobre PRs
code.conventions.read     Le convencoes do time               Skill de code review, style check
```

Skills **compoe** capabilities. O runtime resolve capabilities em MCP tools concretas.

### 3.4 Contratos fortes (input/output)

Cada skill declara:
- **Input contract:** campos obrigatorios no contexto (validados por Zod)
- **Output contract:** campos obrigatorios na resposta (validados por Zod)
- **Trajectory contract:** sequencia esperada de tool calls (pra evals)

### 3.5 Observabilidade nativa

Cada execucao emite:
- Skill invocada, capabilities usadas, tools chamadas
- Params de cada tool call, resultado, latencia
- Tokens de entrada/saida, custo estimado
- Status final (success/failed/skipped), motivo de falha

---

## 4. Arquitetura

### 4.1 Camadas

```
┌─────────────────────────────────────────────────┐
│  SKILL.md (declarativo)                         │
│  name, capabilities, policies, contracts        │
├─────────────────────────────────────────────────┤
│  Skill Provider (codigo leve)                   │
│  blueprint factory, handlers custom, formatacao │
├─────────────────────────────────────────────────┤
│  Capability Modules (building blocks)           │
│  task.context.read, pr.diff.read, ...           │
├─────────────────────────────────────────────────┤
│  Skill Runtime (framework)                      │
│  resolve MCPs, execute blueprint, learn, trace  │
├─────────────────────────────────────────────────┤
│  MCP Layer (protocolo)                          │
│  connect, authenticate, call tools              │
└─────────────────────────────────────────────────┘
```

### 4.2 Fluxo de execucao

```
Trigger (PR comment, webhook, API)
    │
    ▼
Skill Discovery
    Carrega frontmatter de skills instaladas (~100 tokens cada)
    Decide qual skill ativar baseado no trigger
    │
    ▼
Skill Invocation
    Carrega SKILL.md body (instrucoes + policies)
    Valida input contract (campos obrigatorios no contexto)
    │
    ▼
Capability Resolution
    Para cada capability declarada:
        Registry built-in → capabilityToolMap → unknownCapability
        Resolve para MCP tools concretas
    │
    ▼
Blueprint Execution
    Executa steps declarados na skill:
        [deterministic] Capability steps (MCP tool calls)
        [gate]          Validacao/short-circuit
        [llm]           Analise com LLM (SKILL.md como system prompt)
        [format]        Formatacao de resultado
    │
    ▼
Learning Loop
    Registra trace: { tool, status, latencia, params }
    Atualiza estatisticas por scope (org/team/skill/capability/provider)
    Promove tool apos 3+ sucessos com 70%+ taxa
    │
    ▼
Output
    Valida output contract
    Retorna resultado formatado
    Emite metricas de observabilidade
```

### 4.3 Learning Loop

```
Execucao 1 (cold start):
    seededTools = ['getJiraIssue', 'searchJiraIssuesUsingJql']
    cachedTools = []
    preferredTool = undefined
    → Tenta getJiraIssue → SUCESSO
    → stats: { getJiraIssue: { success: 1 } }

Execucao 2-3:
    cachedTools = ['getJiraIssue']
    → getJiraIssue → SUCESSO
    → stats: { success: 3, rate: 100% } → PROMOVIDO

Execucao 4+:
    preferredTool = 'getJiraIssue' (fast path, zero exploration)
    → Resultado direto, sem tentativa de outras tools
```

**Cache em duas camadas:**
- L1: BoundedMap em memoria (FIFO, 512 entries, 60s staleness)
- L2: Redis (7 dias TTL strategy, 24h resource plan)

---

## 5. SKILL.md — Formato

### 5.1 Frontmatter (metadados)

```yaml
---
name: business-rules-validation
description: >
  Validates PR code changes against linked task requirements.
  Identifies gaps between what was implemented and what was specified.
  Use when reviewing PRs that reference Jira, Linear, or other task management tools.
metadata:
  version: '1.0.0'
  kodus:
    capabilities:
      - pr.metadata.read
      - pr.diff.read
      - task.context.read
    fetcher-policy:
      tool-mode: any
      allow-without-tools: false
    execution-policy:
      on-missing-mcp: fail
      on-mcp-connect-error: fail
      fetcher-timeout-ms: 120000
      analyzer-timeout-ms: 120000
    contracts:
      input:
        required-context-fields:
          - organizationAndTeamData.organizationId
          - organizationAndTeamData.teamId
          - prepareContext.pullRequest.pullRequestNumber
          - prepareContext.repository.id
      output:
        required-fields:
          - needsMoreInfo
          - summary
    required-mcps:
      - category: task-management
        label: Task Management
        examples: Jira, Linear, Notion, ClickUp
    capability-tool-map:
      task.context.read: getLinearIssue getNotionPage
---
```

### 5.2 Body (instrucoes)

O corpo do SKILL.md e o system prompt do LLM analyzer. Deve:
- Ser imperativo ("Analise...", "Compare...", "Reporte...")
- Ter <500 linhas (mover detalhes pra references/)
- Incluir exemplos de input/output
- Definir edge cases

### 5.3 References (sob demanda)

```
references/
├── output-format.md         # Template do output esperado
├── quality-classification.md # Regras de EMPTY/MINIMAL/PARTIAL/COMPLETE
└── common-patterns.md       # Padroes comuns de gap
```

---

## 6. Capabilities — Building Blocks

### 6.1 Registry built-in

| Capability | Mode | Tools resolvidas |
|-----------|------|-----------------|
| `pr.diff.read` | `fixed_tools` | `KODUS_GET_PULL_REQUEST_DIFF` |
| `pr.metadata.read` | `fixed_tools` | `KODUS_GET_PULL_REQUEST` |
| `task.context.read` | `provider_dynamic` | Resolvido por provider (Jira, Linear, etc) |

### 6.2 Capability extensivel via SKILL.md

```yaml
capability-tool-map:
  task.context.read: getLinearIssue getNotionPage
  custom.metrics.read: getDatadogMetrics
```

**Prioridade de resolucao:**
1. Registry built-in (tem precedencia)
2. `capability-tool-map` do SKILL.md
3. Se nao encontrado: marca como `unknownCapability`

### 6.3 Seed files (bootstrap de cold start)

```
runtime/capability-seeds/
├── jira/task.context.read.json
├── linear/task.context.read.json
├── clickup/task.context.read.json
└── notion/task.context.read.json
```

Cada seed lista tools candidatas para um provider + capability:
```json
{
    "providerType": "jira",
    "capability": "task.context.read",
    "tools": ["getJiraIssue", "searchJiraIssuesUsingJql", "search", "fetch"]
}
```

---

## 7. Observabilidade

### 7.1 Trace por execucao

Cada execucao gera um array de `CapabilityExecutionTrace`:

```typescript
{
    capability: 'task.context.read',
    mode: 'deterministic' | 'agentic',
    provider: 'jira',
    tool: 'getJiraIssue',
    status: 'success' | 'failed' | 'skipped',
    reason?: 'timeout' | 'no_candidate_tools' | 'mcp_not_connected',
    latencyMs: 342,
    tokensIn?: 150,
    tokensOut?: 800,
}
```

### 7.2 Metricas de producao (target)

| Metrica | O que mostra | Pra quem |
|---------|-------------|----------|
| `skill.activation_rate` | Quantas vezes cada skill foi ativada | Manager |
| `skill.success_rate` | % de execucoes que terminaram com resultado util | Manager |
| `skill.needsMoreInfo_rate` | % de vezes que a skill nao teve contexto suficiente | Manager |
| `capability.tool_success_rate` | % de tool calls bem-sucedidas por capability | Debug |
| `capability.preferred_tool_hit_rate` | % de vezes que a tool promovida foi usada | Debug |
| `skill.latency_p95` | Latencia p95 de execucao | Eng |
| `skill.tokens_total` | Tokens consumidos (custo) | Eng |
| `skill.retry_rate` | % de execucoes com retry | Eng |

### 7.3 Dashboard do manager

```
┌─────────────────────────────────────────┐
│  Skills do Time: Frontend              │
├─────────────────────────────────────────┤
│  business-rules-validation   ● ativo   │
│    Execucoes: 127 | Sucesso: 89%       │
│    Tool preferida: getJiraIssue        │
│    needsMoreInfo: 11% (tasks parciais) │
│                                         │
│  code-conventions-check      ○ inativo │
│    (nao configurado)                    │
└─────────────────────────────────────────┘
```

---

## 8. Evals

### 8.1 Tipos de eval

| Tipo | O que avalia | Exemplo |
|------|-------------|---------|
| **Outcome** | Resultado final esta correto? | "Identificou os 3 gaps entre diff e task?" |
| **Trajectory** | Chamou tools na ordem certa? | "Buscou task antes de analisar diff?" |
| **Process** | Seguiu as regras da skill? | "Classificou qualidade antes de analisar?" |
| **Efficiency** | Gastou recursos razoaveis? | "Usou <3 tool calls pra resolver?" |

### 8.2 Casos minimos (3-8 por skill)

Para business-rules-validation:

```yaml
evals:
  - name: "happy-path-jira-complete"
    input:
      pullRequestNumber: 123
      taskProvider: jira
      taskQuality: COMPLETE
    trajectory:
      - capability: pr.metadata.read
        tool: KODUS_GET_PULL_REQUEST
      - capability: pr.diff.read
        tool: KODUS_GET_PULL_REQUEST_DIFF
      - capability: task.context.read
        tool: getJiraIssue
    outcome:
      needsMoreInfo: false
      summary: contains("gap")

  - name: "empty-task-short-circuit"
    input:
      pullRequestNumber: 456
      taskProvider: jira
      taskQuality: EMPTY
    trajectory:
      - capability: task.context.read
        status: skipped
    outcome:
      needsMoreInfo: true

  - name: "no-mcp-fails-fast"
    input:
      pullRequestNumber: 789
      mcpConnected: false
    outcome:
      error: "mcp_not_connected"
```

### 8.3 Onde rodar

- **Desenvolvimento:** `npx jest test/unit/agents/` (testes unitarios)
- **CI:** eval runner que executa fixtures contra mock MCPs
- **Producao:** sampling de execucoes reais pra monitorar drift

---

## 9. Criar uma skill nova — Developer Experience

### 9.1 O que o parceiro escreve

```
my-skill/
├── SKILL.md              # ~200 linhas (frontmatter + instrucoes)
├── handlers.ts           # ~100-200 linhas (logica custom de cada step)
├── references/           # docs adicionais
└── evals/                # casos de teste
```

**SKILL.md** define: capabilities, policies, contracts, instrucoes.
**handlers.ts** define: como tratar o resultado de cada capability, logica de formatacao, parser de output.

### 9.2 O que o framework fornece

- **Capability modules reutilizaveis** — `task.context.read`, `pr.diff.read` funcionam out-of-the-box
- **Blueprint engine** — orquestra steps, valida contratos, emite metricas
- **Learning loop** — automatico, sem codigo do parceiro
- **MCP resolution** — automatico, baseado nas capabilities declaradas
- **Observabilidade** — tracing emitido pelo runtime, sem codigo do parceiro

### 9.3 O que NAO precisa fazer

- Escrever logica de MCP connection
- Implementar retry/timeout (vem da execution-policy)
- Construir cache de tools (vem do CapabilityStrategyService)
- Montar observabilidade (vem do runtime)

---

## 10. Estado Atual

### 10.1 O que existe (prototipo)

| Componente | Estado | Notas |
|-----------|--------|-------|
| SKILL.md parsing (SkillLoaderService) | Funcional | Frontmatter + body + overlays |
| Capability registry | Funcional | 3 built-in + extensivel via capabilityToolMap |
| Blueprint engine | Funcional | 4 tipos de step, contratos Zod |
| Learning loop | Funcional | Estrategia + promocao + cache 2 camadas |
| Seed files | Funcional | jira, linear, clickup, notion |
| BRV blueprint | Funcional | 6 steps hardcoded |
| BRV agent provider | Funcional | Acoplado ao BRV |
| Testes | 72 testes | 11 arquivos de teste |
| REST API | Funcional | GET /skills/:name/meta, /instructions |

### 10.2 O que falta

| Gap | Prioridade | Impacto |
|-----|-----------|---------|
| Observabilidade (export traces) | ALTA | Sem isso, ninguem confia |
| Evals minimos (3-8 fixtures) | ALTA | Sem isso, nao itera com dados |
| AbstractSkillProvider (base class) | ALTA | Sem isso, skill #2 copia 2000 linhas |
| Capability modules extraidos | MEDIA | Reduz boilerplate por skill de 1500 pra ~100 linhas |
| Progressive disclosure real | MEDIA | Hoje carrega tudo; precisa dos 3 tiers |
| Dashboard de metricas | MEDIA | Manager precisa ver o que acontece |
| Skill config por team (ParametersKey) | BAIXA | Habilitar/desabilitar por time |
| Skill generator (CLI/template) | BAIXA | Scaffold pra parceiros |
| CacheService no AgentsModule | BAIXA | Redis nao injetado (funciona em memoria) |

---

## 11. Roadmap

### Fase 1: Validar o prototipo (BRV end-to-end)
- Fechar gaps tecnicos do BRV
- Rodar com dados reais (PRs + Jira tasks capturados)
- Observar: funciona? onde falha? quanto custa?

### Fase 2: Observabilidade + Evals
- Exportar traces para log estruturado
- Criar 5-8 eval fixtures para BRV
- Metricas basicas: success rate, tool hit rate, latencia, custo
- Iterar BRV com dados reais (nao com vibes)

### Fase 3: Extrair abstracooes
- AbstractSkillProvider (base class do agent provider)
- Capability modules extraidos de blueprint.tooling.ts
- Criar skill #2 simples pra validar que o framework funciona

### Fase 4: Developer Experience
- Template de skill (SKILL.md + handlers.ts + evals/)
- Docs: "Como criar uma skill" com exemplo completo
- Validacao de SKILL.md (schema check)

### Fase 5: Governance + Dashboard
- Config por team (ParametersKey)
- Dashboard de metricas pra manager
- Habilitar/desabilitar skills por time

---

## 12. Referencias

### Mercado e padroes
- [Agent Skills Specification](https://agentskills.io/specification) — padrao aberto
- [Anthropic: Equipping Agents with Skills](https://claude.com/blog/equipping-agents-for-the-real-world-with-agent-skills)
- [Anthropic: Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Anthropic Skills GitHub](https://github.com/anthropics/skills)
- [CodeRabbit](https://www.coderabbit.ai/) — 13M PRs, learning from feedback
- [Cortex 2026 Benchmark](https://www.cortex.io/report/engineering-in-the-age-of-ai-2026-benchmark-report)

### Evals e observabilidade
- Langfuse — tracing + datasets + trajectory evals
- Phoenix/Arize (OSS) — observabilidade + evals
- OpenTelemetry GenAI conventions

### Mapa de arquivos do prototipo

```
libs/agents/skills/
    business-rules-validation/SKILL.md
    runtime/capability-seeds/{jira,linear,clickup,notion}/task.context.read.json
    runtime/
        bounded-map.ts
        capability-hooks.factory.ts
        capability-resource-plan.service.ts
        capability-runtime.resolver.ts
        capability-strategy.service.ts
        deterministic-tool-executor.ts
        skill-runtime.types.ts
        value-utils.ts
    generic-skill-runner.service.ts
    skill-capabilities.ts
    skill-loader.service.ts

libs/agents/infrastructure/services/kodus-flow/
    business-rules-validation/
        blueprint.ts
        blueprint.tooling.ts
        businessRulesValidationAgent.ts
        types.ts

libs/shared/blueprint/
    blueprint.runner.ts
    blueprint.types.ts

test/unit/agents/ (11 arquivos, 72 testes)
```
