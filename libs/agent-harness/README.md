# agent-harness

> `Agent = Model + Harness`. Este pacote é a metade **engine** — o **único loop
> de agent** + controle + observabilidade que transforma um modelo num agent.
> É **agnóstico de domínio**: code-review, conversation, business-rules e skills
> são *aplicações* construídas em cima daqui, não fazem parte dele.

NÃO é a "disciplina harness" inteira (prompts, sandbox, MCP, evals vivem em
volta). É o runtime: *"um sistema que roda tools num loop pra atingir um
objetivo"* + os pontos de controle + o registro observável de cada execução.

## Regra de dependência (inviolável)

```
domínio (libs/code-review, libs/agents, ...)  ──depende──▶  @libs/agent-harness
@libs/agent-harness                              ──NUNCA──▶   domínio
```

`domain/contracts/index.ts` não importa nada de lib de domínio. Se precisar de
algo do domínio, entra via **injeção** (`ToolContext.services`, `AgentSpec`,
policies/verifiers fornecidos pela aplicação) — nunca por import. Ports & adapters:
o core define as portas (contracts), a infra/domínio fornece os adapters.

## Os primitivos (lista fechada — `domain/contracts/`)

| Primitivo | Papel | Uma frase |
|---|---|---|
| `AgentSpec` | o agent como **dado** | systemPrompt + tools + policies + maxSteps + modelId (+ temperature, providerOptions, resultToolName) |
| `AgentRunner` | o **único loop** | `run(spec, input, ctx) → RunState` |
| `RunState` (+ `trace`) | registro **observável por construção** | steps, usage, status, stopReason, artifacts, trace |
| `AgentTool` / `ToolRegistry` / `ToolContext` | **capacidade** + conjunto + contexto por-run | o que o modelo chama no loop. Erros são valores (`ToolResult.isError`), não exceptions |
| `AgentPolicy` | controle **in-loop, por step** | `prepareStep` (steer) + `shouldStop` (parar) |
| `Verifier<T>` (+ `Verdict`) | avaliador **pós-run, por candidato** | o padrão Splits: gerador ≠ avaliador |
| `ModelResolver<TModel>` | abstrai o modelo / BYOK | `resolve(modelId) → model` |
| `Compressor`, `ProgressLedger` | **portas** que policies injetam | compaction / cobertura |

### Policy vs Verifier (a distinção que importa)

| Eixo | `AgentPolicy` | `Verifier<T>` |
|---|---|---|
| Quando | durante o loop, **a cada step** | **depois** do run |
| Sobre o quê | a **trajetória** (`StepView`) | a **saída** (candidatos) |
| Granularidade | por step | por candidato |
| É um agent? | não, é um hook | pode ser (sub-agent, chamada única, ou check determinístico tipo `tsc`) |

Policy guia UMA execução; verifier julga a SAÍDA dela. São pontos de controle
diferentes — **verify não é policy.**

## Implementações (`infrastructure/`)

| Peça | O que é |
|---|---|
| `ai-sdk/ai-sdk-agent-runner` → `AiSdkAgentRunner` | a **única** impl de `AgentRunner` (sobre Vercel AI SDK) |
| `ai-sdk/ai-sdk-tool-registry` → `AiSdkToolRegistry` | carrega tools nativos do AI SDK (MCP/Zod) sem round-trip de schema |
| `tools/in-memory-tool-registry` → `InMemoryToolRegistry` | registry de `AgentTool` (JSON-Schema) |
| `policies/` → `BudgetPolicy`, `CompressionPolicy`, `CompletionGatePolicy`, `ForceFinalizePolicy` | Budget + Compression genéricas; CompletionGate + ForceFinalize são do padrão "result-tool" |
| `compression/` → `ContextWindowCompressor` (+ `context-compressor`) | impl canônica do `Compressor` (janela de token); usada por code-review **e** pelo fetcher de skills via `CompressionPolicy` |
| `verify/` → `llm-verdict` (`buildVerifierAgentSpec` / `extractVerdict` / `submitVerdictTool`) | scaffolding genérico de `Verdict` (doer≠checker, fail-open) — um domínio só fornece prompt + candidato→prompt |
| `orchestration/verification-pass` → `runVerificationPass<T>` | driver do `Verifier<T>` sobre um conjunto de candidatos |
| `orchestration/sub-agent.factory` → `DefaultSubAgentFactory` | sub-agent-como-tool |

## Capacidades do `AiSdkAgentRunner`

- **Tools**: 2 caminhos — `AgentTool → aiTool()`, ou passthrough nativo via `AiSdkToolRegistry`.
- **System prompt**: string, ou com `systemProviderOptions` (cache Anthropic).
- **Config de chamada**: `temperature`, `maxOutputTokens`, `providerOptions`.
- **Telemetria**: `input.telemetry` → AI SDK `telemetry` (+ `runtimeContext` when metadata is present; Langfuse).
- **Cancelamento**: `ctx.signal` → `abortSignal`.
- **Parada**: `policy.shouldStop` (OR) + `stepCountIs(maxSteps)` fail-open.
- **Steer por step**: diretivas de `policy.prepareStep` mescladas; `sanitizeNoSystem`.

## Dois modos de saída

1. **Estruturado ("result tool")** — setar `spec.resultToolName`; o runner
   materializa cada chamada nele em `RunState.artifacts`. O domínio lê
   `state.artifacts` (ex.: findings do finder). Nunca re-escaneia `steps` na mão.
2. **Free-form** — sem `resultToolName`; a resposta é o último turno assistant.
   Use o helper `finalText(state)` (`domain/run-state.util`). Usado por
   conversation e business-rules.

## Recipe — como criar um agente novo

Todo agente segue **os mesmos 6 passos**, usando os helpers compartilhados (é o
padrão que code-review, conversation, business e skills já seguem). Composição
explícita — sem fábrica. Cada passo tem UM helper:

```ts
// 1. MODELO — resolve BYOK + wrap de concorrência + reporter de falha (1 helper)
const model = resolveAgentModel(byokConfig, {
  organizationId, provider: byokConfig?.main?.provider,
  reporter: byokErrorCounter ? (e) => void byokErrorCounter.record(e) : undefined,
});
const runner = new AiSdkAgentRunner({ resolve: () => model });

// 2. TOOLS — AiSdkToolRegistry (tools nativos AI SDK: MCP/Zod) OU InMemoryToolRegistry (AgentTool JSON-Schema)
const tools = new AiSdkToolRegistry({ ...mcp.tools, ...native });

// 3. SPEC — o agente como dado
const spec: AgentSpec = {
  id: 'my-agent',
  systemPrompt,
  modelId: 'resolved',
  tools,
  policies: [],                 // BudgetPolicy/CompressionPolicy... se precisar
  maxSteps: 12,
  temperature: 0,               // opcional
  // resultToolName: 'submit',  // SÓ se a saída for estruturada (artifacts)
};

// 4. CONTEXT — signal + timeout duro (1 helper). cleanup no finally.
const { ctx, cleanup } = createAgentRunContext({ runId, parentSignal });

// 5. RUN
try {
  const state = await runner.run(
    spec,
    { prompt, telemetry: buildLangfuseTelemetry('my-agent', meta) },
    ctx,
  );

  // 6. SAÍDA + CUSTO
  const answer = finalText(state);          // free-form (chat/análise)
  // const findings = state.artifacts;      // estruturado (result-tool)
  await observability.recordAgentRunUsage({
    agentName: 'MyAgent', phase: 'run', model: byokConfig?.main?.model,
    isByok: !!byokConfig, usage: state.usage, organizationId, teamId,
  });
  return answer;
} finally {
  cleanup();
}
```

Regra: **os passos 1, 4 e 6 são idênticos em todo agente** (helpers compartilhados:
`resolveAgentModel`, `createAgentRunContext`, `recordAgentRunUsage`); só **2 (tools),
3 (spec/prompt) e a saída** mudam por domínio. Se precisar de verificação
(gerador≠avaliador), componha um `Verifier<T>` via `runVerificationPass`.

## Fronteira

- Harness é **genérico** — contracts não importam domínio.
- O **domínio** fornece os concretos: finder tools, `LlmVerifier`, o `Finding`/
  funil de review, `DiffCoverageLedger`. Mapeia `Artifact` → seu shape.
- **Observabilidade** (`recordAgentRunUsage`, schema único de custo) mora em
  `@libs/core/log/observability.service` — compartilhada, alimentada por
  `RunState.usage`. Fora do harness de propósito (acoplaria o engine ao pipeline de custo).

## Consumidores hoje

| Consumidor | No runner? | Tools | Policies | Saída | Verifier |
|---|---|---|---|---|---|
| **code-review** (finder/verify) | ✅ | `InMemoryToolRegistry` | Budget + Compression + CompletionGate + ForceFinalize | `resultToolName` | ✅ `runVerificationPass` (LLM) |
| **skills** (fetcher) | ✅ | registry MCP | `[]` | free-form | ❌ |
| **conversation** | ✅ | `AiSdkToolRegistry` | `[]` | free-form (`finalText`) | ❌ |
| **business-rules** | ✅ | — (fetch via skill) | `[]` | free-form (`finalText`) | ❌ |

`business-rules` roda **todo no harness**: a fase de **fetch** é uma skill cujo
fetcher é um agent do runner (com MCP); a **análise** é single-shot no runner
(`maxSteps:1`, sem tools). Os 3 (+skills) estão no mesmo engine.

## Não-objetivos conscientes (decisões, não dívida)

- **Hooks de lifecycle** (after-edit / pre-commit / auto-format) — miram agents
  que **escrevem**; os nossos são sensores read-only. Isolamento do sandbox +
  `abortSignal` + `ToolResult` (erros-como-valor) + `activeTools` já cobrem o
  sliver aplicável. Cross-cutting por-tool (redação de secret, telemetria por-tool)
  vira um **decorator de `AgentTool`**, não um sistema de hooks.
- **Verifier computacional** (tsc/jest back-pressure) — adiado; encaixa no
  `Verifier<T>` quando voltarmos.
- **Tool-call offloading / progressive disclosure / planning** — não necessários
  pros 3 usos atuais.
- **Git-as-durable-state / commits** — só relevante se criarmos um agent que escreve.

## Princípios (pesquisa SOTA + harness-engineering 2024-2026)

1. **Loop fino + seams** — concern não mora no loop, mora numa Policy composável.
2. **Papel = config, não fork** — um runner só; varia prompt+tools (prática Anthropic).
3. **Sub-agent = tool** — orquestração (réplicas, parent/child) é compor o mesmo runner.
4. **Splits** — gerador (finder) ≠ avaliador (verifier); evita o viés de auto-correção.
5. **Observável por construção** — `RunState`/`trace` mata o "funil reconstruído por heurística".
6. **Determinístico testável** — mockar o model (`ai/test`), testar policies isoladas.

## Estado

- [x] L1 contracts (`domain/contracts`)
- [x] L1 infra: `AiSdkAgentRunner` sobre Vercel AI SDK (stopWhen/prepareStep/tools/telemetry)
- [x] Policies: Budget, Compression, CompletionGate, ForceFinalize
- [x] Verifier + `runVerificationPass` (Splits) · `SubAgentFactory`
- [x] `AiSdkToolRegistry` (tools nativos AI SDK sem round-trip)
- [x] `finalText(state)` helper (`domain/run-state.util`) — usado por conversation + business
- [x] Consumidores: code-review (full), skills (fetcher), conversation, **business (todo no harness)**
- [ ] **Próxima passada:** estender o funil de review (gates dedup G1 / severity G3); avaliar policies pra conversation/business se precisarem
