# Skills Framework — Plano de Implementacao

> Este documento e o plano de execucao. Outro agent vai implementar seguindo estas instrucoes.
> Cada task tem: o que fazer, onde fazer, como fazer, e criterio de done.

## Pre-requisitos

- Branch: `001-skills-framework`
- Rodar testes antes de comecar: `npx jest test/unit/agents/ --no-coverage`
- Existem 2 testes pre-existentes falhando em `blueprint.spec.ts` — serao corrigidos no Bloco A

---

## BLOCO A — Fechar o prototipo (BRV funciona end-to-end)

### A1. Validar remocao de `availableTools`

**Status:** Edicoes ja feitas. Falta validar.

**O que foi feito:**
- `types.ts:24` — campo `availableTools?: string[]` removido de `BusinessRulesPrepareContext`
- `blueprint.tooling.ts` — funcao `resolveExecutionAvailableTools()` removida
- `blueprint.tooling.ts` — parametro `executionAvailableTools` removido de `resolveTaskContextDeterministicAllowlist()` e `applyTaskContextToolBoundary()`
- `blueprint.tooling.ts` — call site limpo (L446-467)

**Acao:** Rodar `npx jest test/unit/agents/ --no-coverage` e confirmar que nenhum teste novo quebrou por causa disso.

**Done:** Testes passam (exceto os 2 pre-existentes do A2).

---

### A2. Corrigir os 2 testes falhando em `blueprint.spec.ts`

**Arquivo:** `test/unit/agents/business-rules-validation/blueprint.spec.ts`

**Testes falhando:**
1. `"supports agent-first mode and saves learned tools to cache hook"`
2. `"blocks write tools in deterministic task.context.read via explicit allowlist"`

**Root cause:** Os testes criam mocks sem seed files. Sem seeds, `resolveTaskContextDeterministicAllowlist()` retorna Set vazio, e `getTaskContextCandidateTools()` filtra tudo via allowlist vazia.

**Como corrigir:**
1. Ler os 2 testes falhando no arquivo
2. No setup de cada teste, adicionar mock de `getSeedTaskContextTools` que retorna tools relevantes
3. Verificar que o `hooks.getSeedTaskContextTools` mock retorna pelo menos as tools que o teste espera usar

**Exemplo de fix (pseudocodigo):**
```typescript
// No setup do teste "blocks write tools":
hooks.getSeedTaskContextTools.mockResolvedValue(['getJiraIssue', 'searchJiraIssuesUsingJql']);

// No setup do teste "agent-first mode":
hooks.getSeedTaskContextTools.mockResolvedValue(['search']);
```

**Done:** Ambos os testes passam. Rodar `npx jest test/unit/agents/business-rules-validation/blueprint.spec.ts --no-coverage` com 0 falhas.

---

### A3. Exportar traces como log estruturado

**Arquivo:** `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent.ts`

**Onde:** No metodo `execute()`, logo apos o `runBlueprint()` retornar (linha ~295-309), ANTES do return.

**O que fazer:** Adicionar log estruturado com todos os traces da execucao.

**Como:**
```typescript
// Apos linha 307 (depois do log "Business rules validation completed")
// e ANTES do return na linha 309

const traces = result.context.capabilityExecutionTrace ?? [];
if (traces.length > 0) {
    this.logger.log({
        message: 'Capability execution traces',
        context: BusinessRulesValidationAgentProvider.name,
        serviceName: BusinessRulesValidationAgentProvider.name,
        metadata: {
            organizationId: normalizedContext.organizationAndTeamData?.organizationId,
            teamId: normalizedContext.organizationAndTeamData?.teamId,
            skill: SKILL_NAME,
            traceCount: traces.length,
            traces: traces.map((t) => ({
                capability: t.capability,
                mode: t.mode,
                provider: t.provider,
                tool: t.toolName,
                status: t.status,
                reason: t.reason,
                latencyMs: t.latencyMs,
            })),
        },
    });
}
```

**Done:** Ao rodar o BRV, os traces aparecem no log com todos os campos. Teste existente `business-rules-validation-agent.spec.ts` continua passando.

---

### A4. Criar `references/output-format.md`

**Arquivo NOVO:** `libs/agents/skills/business-rules-validation/references/output-format.md`

**Context:** O `SkillLoaderService.loadFromFilesystem()` (L204-221) ja le automaticamente todos os `.md` em `references/` e concatena ao body do SKILL.md. Entao basta criar o arquivo.

**Conteudo:** Exemplos concretos de output bom para o LLM. O conteudo deve incluir:

1. Exemplo de output quando `needsMoreInfo = false` e ha gaps encontrados:
   - Mostrar findings com severidade (MUST_FIX, SUGGESTION, INFO)
   - Cada finding com: descricao, evidencia do diff (trecho), evidencia da task (criterio), acao sugerida
   - Formato markdown que sera postado como PR comment

2. Exemplo de output quando `needsMoreInfo = false` e esta tudo compliant:
   - Summary curto confirmando que implementacao atende os requisitos
   - Lista do que foi verificado

3. Exemplo de output quando `needsMoreInfo = true`:
   - Mensagem clara do que falta
   - Como o usuario pode resolver (linkar Jira ticket, adicionar acceptance criteria)

4. Regras de severidade:
   - `MUST_FIX`: Requisito da task nao implementado, regra de negocio ausente
   - `SUGGESTION`: Edge case nao coberto, melhoria de robustez
   - `INFO`: Observacao que nao bloqueia mas vale atentar

**Formato do arquivo:**
```markdown
# Output Format Reference

## Finding Structure

Each finding MUST include:
- **Severity**: MUST_FIX | SUGGESTION | INFO
- **What**: O que esta faltando ou incorreto
- **Evidence (Task)**: Trecho do requisito da task que sustenta o finding
- **Evidence (Code)**: Trecho do diff que mostra a ausencia ou erro
- **Action**: O que o dev deve fazer

## Example: Gaps Found
(incluir exemplo completo aqui)

## Example: All Compliant
(incluir exemplo completo aqui)

## Example: Needs More Info
(incluir exemplo completo aqui)
```

**IMPORTANTE:** O LLM vai ler este arquivo como parte do system prompt. Manter conciso — maximo 200 linhas.

**Done:** Arquivo existe, contem exemplos dos 3 cenarios, e `SkillLoaderService` o carrega automaticamente (verificar com teste existente `skill-loader.service.spec.ts`).

---

### A5. Criar `references/quality-classification.md`

**Arquivo NOVO:** `libs/agents/skills/business-rules-validation/references/quality-classification.md`

**Context:** O step `classifyTaskContext` usa a funcao `classifyTaskQuality()` de `blueprint.tooling.ts`. O LLM analyzer precisa entender o que cada nivel de qualidade significa pra calibrar a analise.

**Conteudo:**
```markdown
# Task Quality Classification

The runtime classifies task context quality BEFORE the LLM analysis.
Do NOT reclassify — use the provided classification.

## Levels

### COMPLETE
- Has title, description, AND acceptance criteria
- Analysis should be thorough — compare each criterion against the diff

### PARTIAL
- Has title and description but no acceptance criteria
- Analysis should focus on what the description implies
- Flag that acceptance criteria are missing but do best-effort analysis

### MINIMAL
- Has only title (or very short description)
- Analysis should be conservative — only flag obvious gaps
- Recommend adding more detail to the task

### EMPTY
- No meaningful task context found
- Runtime will short-circuit BEFORE reaching the analyzer
- If you receive EMPTY, respond with needsMoreInfo = true
```

**Done:** Arquivo existe, maximo 50 linhas.

---

### A6. Atualizar SKILL.md body para usar findings com severidade

**Arquivo:** `libs/agents/skills/business-rules-validation/SKILL.md`

**O que mudar no body (apos o frontmatter):**

1. Na secao `## Output Format`, atualizar o schema JSON para incluir findings estruturados:

```json
{
  "needsMoreInfo": boolean,
  "missingInfo": "...",
  "summary": "Complete markdown with structured findings"
}
```

2. Na secao `### When needsMoreInfo = false`, atualizar o template do `summary` para incluir findings com severidade:

```markdown
## Business Rules Validation

**Status:** Issues Found / Compliant
**Confidence:** high | medium | low

### Findings

#### MUST_FIX: [titulo do finding]
**Requirement:** [trecho do criterio da task]
**Missing in code:** [o que nao foi implementado]
**Suggested action:** [o que o dev deve fazer]

#### SUGGESTION: [titulo do finding]
...

### Implemented Correctly
[lista do que esta OK]
```

3. Adicionar nota referenciando os reference files:
```markdown
See the reference files for detailed output examples and quality classification rules.
```

**IMPORTANTE:** Nao mexer no frontmatter YAML. So no body markdown.

**Done:** SKILL.md body atualizado. Testes existentes `skill-loader.service.spec.ts` continuam passando (o teste checa `instructions.toContain('# Business Rules Gap Analysis')` — manter esse header).

---

## BLOCO B — Capabilities como building blocks

> Objetivo: extrair de `blueprint.tooling.ts` (1537 linhas) modulos reutilizaveis que qualquer skill pode usar.

### B1. Extrair `pr-metadata-read` capability module

**Arquivo NOVO:** `libs/agents/skills/capabilities/pr-metadata-read.ts`

**Extrair de `blueprint.tooling.ts`:**
- Funcao que monta args pra `KODUS_GET_PULL_REQUEST` (buscar organizationId, teamId, repo, prNumber do contexto)
- Chamada `executeDeterministicTool` pro capability `pr.metadata.read`
- Parsing do resultado (extrair body/description do PR)

**Interface do modulo:**
```typescript
import { CapabilityExecutionTrace, ToolCaller } from '../runtime/skill-runtime.types';
import { BlueprintContext } from '@libs/shared/blueprint/blueprint.types';

export interface PrMetadataReadParams {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName?: string;
    pullRequestNumber: number;
}

export interface PrMetadataReadResult {
    body: string | undefined;
    traces: CapabilityExecutionTrace[];
}

export async function fetchPullRequestMetadata(
    toolCaller: ToolCaller,
    toolName: string,
    params: PrMetadataReadParams,
    ctx: { skillName: string; organizationId: string; teamId: string },
): Promise<PrMetadataReadResult> {
    // Logica extraida de blueprint.tooling.ts
}
```

**Regras:**
- NAO importar `BusinessRulesContext` — receber params tipados
- NAO importar nada de `business-rules-validation/` — ser generico
- Importar APENAS de `skills/runtime/` e `@libs/shared/`
- Retornar traces como array (nao modificar contexto — quem chama decide como mergear)

**De onde extrair no `blueprint.tooling.ts`:**
- A funcao `fetchPullRequestBody` dentro de `createBusinessRulesBlueprintTooling`
- Buscar a parte que monta `PullRequestMetadataToolArgs` e chama `executeDeterministicTool`

**Done:** Modulo exporta `fetchPullRequestMetadata()`. Nenhum import de `business-rules-validation/`.

---

### B2. Extrair `pr-diff-read` capability module

**Arquivo NOVO:** `libs/agents/skills/capabilities/pr-diff-read.ts`

**Mesmo padrao do B1, mas para:**
- Funcao que monta args pra `KODUS_GET_PULL_REQUEST_DIFF`
- Interface `PrDiffReadParams` e `PrDiffReadResult`

**De onde extrair:** A funcao `fetchPullRequestDiff` dentro de `createBusinessRulesBlueprintTooling`.

**Done:** Modulo exporta `fetchPullRequestDiff()`. Nenhum import de `business-rules-validation/`.

---

### B3. Extrair `task-context-read` capability module

**Arquivo NOVO:** `libs/agents/skills/capabilities/task-context-read.ts`

**Este e o MAIOR — contem o grosso das 1537 linhas de `blueprint.tooling.ts`.**

**O que extrair:**
- Toda a logica de `fetchTaskContext` de `createBusinessRulesBlueprintTooling`
- `resolveTaskContextProviders()`
- `resolveTaskContextDeterministicAllowlist()`
- `getTaskContextCandidateTools()`
- `applyTaskContextToolBoundary()`
- `orderCandidateTools()`
- `buildArgsForToken()`
- `maybePersistLearnedTools()`
- Helpers: `extractIssueKeys()`, `extractLinks()`, `isLikelyUrl()`, `isLikelyIssueKey()`
- `firstNonEmptyString()`, `firstNonEmptyValue()`, `extractStringArray()`
- `normalizeTaskPayload()`
- `shouldUseAgenticTaskContextFallback()`

**Interface do modulo:**
```typescript
export interface TaskContextReadParams {
    skillName: string;
    organizationId: string;
    teamId: string;
    pullRequestNumber: number;
    prBody?: string;
    headRef?: string;
    taskContextResolutionMode?: 'cache_first' | 'agent_first';
    enableAgenticFallback?: boolean;
}

export interface TaskContextReadResult {
    normalized: TaskContextNormalized | undefined;
    raw: string;
    traces: CapabilityExecutionTrace[];
}

export interface TaskContextReadHooks {
    getSeedTaskContextTools: (provider: string, capability: string) => Promise<string[]>;
    getCachedTaskContextTools: (scope: CapabilityStrategyScope) => Promise<string[]>;
    saveCachedTaskContextTools: (scope: CapabilityStrategyScope, tools: string[]) => Promise<void>;
    resolvePreferredTool: (scope: CapabilityStrategyScope, candidates: string[]) => Promise<string | undefined>;
    recordExecution: (trace: CapabilityExecutionTrace) => Promise<void>;
}

export async function fetchTaskContext(
    toolCaller: ToolCaller,
    capabilityRuntime: SkillCapabilityRuntimeConfig,
    params: TaskContextReadParams,
    hooks?: TaskContextReadHooks,
): Promise<TaskContextReadResult> {
    // Logica extraida de blueprint.tooling.ts
}
```

**Regras:**
- NAO importar `BusinessRulesContext` — receber params via `TaskContextReadParams`
- `TaskContextNormalized` pode ser exportada daqui (ou de um types compartilhado)
- Manter TODA a logica existente (deterministic loop, agentic fallback, allowlist, learning)
- Apenas mudar a interface: em vez de ler do `ctx.prepareContext.*`, receber via params

**Done:** Modulo exporta `fetchTaskContext()`. Logica identica ao atual. Nenhum import de `business-rules-validation/`.

---

### B4. Criar barrel export

**Arquivo NOVO:** `libs/agents/skills/capabilities/index.ts`

```typescript
export { fetchPullRequestMetadata } from './pr-metadata-read';
export type { PrMetadataReadParams, PrMetadataReadResult } from './pr-metadata-read';

export { fetchPullRequestDiff } from './pr-diff-read';
export type { PrDiffReadParams, PrDiffReadResult } from './pr-diff-read';

export { fetchTaskContext } from './task-context-read';
export type { TaskContextReadParams, TaskContextReadResult, TaskContextReadHooks } from './task-context-read';
```

**Done:** Import via `@libs/agents/skills/capabilities` funciona.

---

### B5. Refatorar `blueprint.tooling.ts` para usar os capability modules

**Arquivo:** `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/blueprint.tooling.ts`

**O que fazer:**
1. Importar dos capability modules
2. `createBusinessRulesBlueprintTooling` passa a ser um wrapper fino que:
   - Extrai params do `BusinessRulesContext`
   - Chama os capability modules com params tipados
   - Retorna no formato `ToolingResult<T>` esperado pelo blueprint

3. Funcoes que foram extraidas sao REMOVIDAS deste arquivo
4. Funcoes que sao BRV-especificas FICAM: `classifyTaskQuality()`, `resolvePullRequestDescription()`, `resolveTaskContext()`

**Resultado esperado:** `blueprint.tooling.ts` cai de ~1537 linhas para ~200-300 linhas (wrapper + funcoes BRV-especificas).

**Done:** `blueprint.tooling.ts` importa de `@libs/agents/skills/capabilities`. Todos os testes passam. Comportamento identico.

---

### B6. Mover `TaskContextNormalized` para types compartilhado

**De:** `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/types.ts`
**Para:** `libs/agents/skills/runtime/skill-runtime.types.ts` (ou novo arquivo `libs/agents/skills/capabilities/types.ts`)

**Motivo:** O type `TaskContextNormalized` e usado pelo capability module `task-context-read.ts`. Nao pode depender de `business-rules-validation/types.ts`.

**Acao:**
1. Mover a interface `TaskContextNormalized` para o novo local
2. Em `business-rules-validation/types.ts`, re-exportar: `export type { TaskContextNormalized } from '...'`
3. Atualizar imports em todos os arquivos que usam

**Done:** `TaskContextNormalized` importavel de fora de `business-rules-validation/`. Nenhum import quebrado.

---

## BLOCO C — AbstractSkillProvider

### C1. Criar `AbstractSkillProvider`

**Arquivo NOVO:** `libs/agents/skills/abstract-skill-provider.ts`

**O que extrair de `businessRulesValidationAgent.ts`:**

Todo o metodo `execute()` (L88-309) contem logica generica que funciona pra qualquer skill:
- Validar `organizationAndTeamData` (L95-99)
- Buscar userLanguage (L101-103)
- Log de inicio (L105-115)
- Fetch BYOK config (L117)
- Criar fetcher orchestration (L119-184)
- Montar initialCtx (L186-191)
- Build capability hooks (L193-199)
- Rodar blueprint (L204-235)
- Catch de erros MCP e contract (L236-293)
- Log de conclusao (L295-307)
- Exportar traces (NOVO — A3)
- Return response (L309)

**O que e BRV-especifico e FICA no BRV:**
- `createBusinessRulesBlueprint()` — factory dos steps
- `runAnalyzer()` — handler do step LLM
- `parseValidationResult()` — parser de resultado
- `buildAnalysisPrompt()` — montagem do prompt
- `defaultLLMConfig` — config do modelo (embora possa virar parametrizavel)

**Interface:**
```typescript
import { BlueprintContext } from '@libs/shared/blueprint/blueprint.types';

export abstract class AbstractSkillProvider<
    TContext extends BlueprintContext,
> extends BaseAgentProvider {

    protected abstract readonly skillName: string;

    /**
     * Cria os steps do blueprint para esta skill.
     */
    protected abstract createBlueprint(
        fetcher: ToolCaller,
        capabilityRuntime: SkillCapabilityRuntimeConfig,
        hooks?: CapabilityExecutionHooks<TContext>,
    ): BlueprintStep<TContext>[];

    /**
     * Handler para steps do tipo 'llm'.
     */
    protected abstract runLLMStep(
        step: LLMStep,
        ctx: TContext,
    ): Promise<TContext>;

    /**
     * Extrai o texto final de resposta do contexto.
     * Default: ctx.formattedResponse
     */
    protected extractResponse(ctx: TContext): string {
        return (ctx as any).formattedResponse ?? '';
    }

    /**
     * Cria o contexto inicial a partir dos params de entrada.
     */
    protected abstract createInitialContext(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
        userLanguage: string;
    }): TContext;

    /**
     * Metodo execute generico — NAO precisa ser sobrescrito.
     */
    async execute(context: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
    }): Promise<string> {
        // 1. Validacao
        // 2. userLanguage
        // 3. BYOK config
        // 4. createFetcherOrchestration (try/catch com MCP errors)
        // 5. createInitialContext()
        // 6. buildCapabilityHooks()
        // 7. runBlueprint(createBlueprint(...), ctx, runLLMStep)
        // 8. Export traces
        // 9. Return extractResponse(result.context)
    }
}
```

**Done:** `AbstractSkillProvider` existe. NAO muda nenhum comportamento existente.

---

### C2. BRV extends AbstractSkillProvider

**Arquivo:** `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent.ts`

**O que fazer:**
1. `BusinessRulesValidationAgentProvider extends AbstractSkillProvider<BusinessRulesContext>`
2. Implementar `createBlueprint()` — chama `createBusinessRulesBlueprint()`
3. Implementar `runLLMStep()` — chama `this.runAnalyzer()`
4. Implementar `createInitialContext()` — monta `BusinessRulesContext`
5. REMOVER todo o codigo generico do `execute()` (ja esta no abstract)
6. MANTER: `runAnalyzer()`, `parseValidationResult()`, `buildAnalysisPrompt()`, `defaultLLMConfig`

**Resultado esperado:** `businessRulesValidationAgent.ts` cai de ~700 linhas para ~350 linhas (so logica BRV-especifica).

**Done:** Todos os testes passam. Comportamento identico. `BusinessRulesValidationAgentProvider` implementa apenas os metodos abstratos.

---

## BLOCO D — Progressive disclosure (3 tiers)

### D1. Separar loading em tiers no SkillLoaderService

**Arquivo:** `libs/agents/skills/skill-loader.service.ts`

**O que mudar:**

1. `loadFromFilesystem()` (L204-221) — PARAR de concatenar references automaticamente:

**Antes:**
```typescript
const refs = this.loadReferences(skillName);
return refs ? `${body}\n\n---\n\n## Reference Material\n\n${refs}` : body;
```

**Depois:**
```typescript
return body; // Tier 2: so o body do SKILL.md
```

2. Criar metodo publico `loadReference(skillName: string, fileName: string): string | null`:
```typescript
loadReference(skillName: string, fileName: string): string | null {
    const refPath = this.resolveSkillFilePath(skillName, path.join('references', fileName));
    if (!refPath) return null;
    return fs.readFileSync(refPath, 'utf-8');
}
```

3. Criar metodo publico `listReferences(skillName: string): string[]`:
```typescript
listReferences(skillName: string): string[] {
    const refsDir = this.resolveSkillDirectoryPath(skillName, 'references');
    if (!refsDir) return [];
    return fs.readdirSync(refsDir).filter(f => f.endsWith('.md')).sort();
}
```

4. Atualizar `getAnalyzerInstructions()` no `GenericSkillRunnerService` — agora ELE decide se carrega references:
```typescript
getAnalyzerInstructions(skillName: string, options?: ...): string {
    const base = this.skillLoaderService.loadInstructions(skillName, options);
    // Tier 3: carregar references se necessario
    const refs = this.skillLoaderService.listReferences(skillName);
    if (refs.length === 0) return base;

    const refContent = refs
        .map(f => this.skillLoaderService.loadReference(skillName, f))
        .filter(Boolean)
        .join('\n\n---\n\n');

    return `${base}\n\n---\n\n## Reference Material\n\n${refContent}`;
}
```

**IMPORTANTE:** Isso muda o comportamento do `loadInstructions()`. O teste `skill-loader.service.spec.ts` que checa `instructions.not.toContain('## Reference Material')` ja ESPERA esse comportamento. Verificar que continua passando.

**Done:** References nao sao mais concatenados automaticamente. Testes passam.

---

## BLOCO E — Evals minimos

### E1. Criar fixture de eval: happy path Jira COMPLETE

**Arquivo NOVO:** `test/evals/business-rules-validation/fixtures/happy-path-jira-complete.json`

**Conteudo:** Capturar um caso real (ou sintetico realista):
```json
{
    "name": "happy-path-jira-complete",
    "input": {
        "pullRequestNumber": 100,
        "prBody": "Implements user authentication flow as described in PROJ-123",
        "prDiff": "diff --git a/src/auth.ts ...(diff real ou sintetico)...",
        "taskContext": {
            "id": "PROJ-123",
            "title": "Implement user authentication",
            "description": "Add login/logout flow with JWT tokens",
            "acceptanceCriteria": [
                "User can login with email/password",
                "JWT token is returned on success",
                "Invalid credentials return 401",
                "Logout invalidates the token"
            ]
        }
    },
    "expectedTrajectory": [
        { "capability": "pr.metadata.read", "status": "success" },
        { "capability": "pr.diff.read", "status": "success" },
        { "capability": "task.context.read", "status": "success" },
        { "step": "classifyTaskContext", "output": { "taskQuality": "COMPLETE" } },
        { "step": "validateContext", "passed": true },
        { "step": "analyzeBusinessRules", "status": "success" }
    ],
    "expectedOutcome": {
        "needsMoreInfo": false,
        "summaryContains": ["PROJ-123", "authentication"]
    }
}
```

### E2. Criar fixture: empty task short-circuit

**Arquivo NOVO:** `test/evals/business-rules-validation/fixtures/empty-task-short-circuit.json`

```json
{
    "name": "empty-task-short-circuit",
    "input": {
        "pullRequestNumber": 200,
        "prBody": "Fix bug",
        "prDiff": "...",
        "taskContext": ""
    },
    "expectedTrajectory": [
        { "step": "classifyTaskContext", "output": { "taskQuality": "EMPTY" } },
        { "step": "validateContext", "passed": false }
    ],
    "expectedOutcome": {
        "needsMoreInfo": true
    }
}
```

### E3. Criar fixture: partial task analysis

**Arquivo NOVO:** `test/evals/business-rules-validation/fixtures/partial-task-analysis.json`

Similar ao E1 mas com `taskQuality: "PARTIAL"` — task tem titulo e descricao mas sem acceptance criteria.

### E4. Criar eval runner basico

**Arquivo NOVO:** `test/evals/business-rules-validation/eval-runner.spec.ts`

**O que faz:**
1. Carrega cada fixture JSON
2. Monta o `BusinessRulesContext` com os dados da fixture
3. Roda os steps deterministicos do blueprint (com mocks de tool calls)
4. Verifica trajectory (quais steps rodaram, em que ordem, com que status)
5. Verifica outcome (`needsMoreInfo`, conteudo do `summary`)

**NAO faz:**
- NAO chama LLM real (mock do `runAnalyzer`)
- NAO conecta MCP real (mock do `toolCaller`)

**Objetivo:** Validar que o pipeline deterministico funciona corretamente. O step LLM e mockado com resposta esperada da fixture.

**Done:** `npx jest test/evals/ --no-coverage` passa com todos os fixtures.

---

## BLOCO F — Observabilidade (complemento ao A3)

### F1. Capturar token count do LLM response

**Arquivo:** `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent.ts`

**Onde:** No metodo `runAnalyzer()`, apos `analyzerAdapter.call()` retornar.

**O que fazer:** O response do LLM adapter inclui `usage` (ou similar). Capturar e incluir no trace.

```typescript
const analysisResult = await this.withTimeout(
    analyzerAdapter.call({...}),
    executionPolicy.analyzerTimeoutMs,
    `business-rules-analyzer-attempt-${attempt}`,
);

// Capturar tokens se disponivel
const tokensIn = analysisResult.usage?.promptTokens ?? 0;
const tokensOut = analysisResult.usage?.completionTokens ?? 0;
```

**Incluir no log de conclusao (A3) ou como metrica separada.**

**Done:** Tokens aparecem no log estruturado.

---

## Ordem de execucao recomendada

```
1. BLOCO A (A1 → A2 → A3 → A4 → A5 → A6)
   Rodar testes: npx jest test/unit/agents/ --no-coverage
   Resultado: 0 falhas, BRV funciona com output melhorado

2. BLOCO B (B6 → B1 → B2 → B3 → B4 → B5)
   B6 primeiro (mover type) para desbloquear B1-B3
   Rodar testes apos cada step
   Resultado: capability modules extraidos, blueprint.tooling.ts enxuto

3. BLOCO C (C1 → C2)
   Rodar testes apos cada step
   Resultado: AbstractSkillProvider pronto, BRV refatorado

4. BLOCO D (D1)
   Rodar testes apos
   Resultado: progressive disclosure funcional

5. BLOCO E (E1 → E2 → E3 → E4)
   Resultado: eval fixtures + runner basico

6. BLOCO F (F1)
   Resultado: token counting no trace
```

## Verificacao final

Apos todos os blocos:
1. `npx jest test/unit/agents/ --no-coverage` — 0 falhas
2. `npx jest test/evals/ --no-coverage` — 0 falhas
3. `npx tsc --noEmit` — 0 erros de tipo
4. `blueprint.tooling.ts` tem <300 linhas
5. `businessRulesValidationAgent.ts` tem <400 linhas
6. Capability modules existem em `libs/agents/skills/capabilities/`
7. `AbstractSkillProvider` existe e BRV o estende
8. References existem em `libs/agents/skills/business-rules-validation/references/`
9. Traces aparecem no log estruturado
