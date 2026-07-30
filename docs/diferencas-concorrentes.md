# Diferenças em relação aos concorrentes (dados públicos)

> **Escopo e método.** Levantamento feito sobre material **público** (engineering blogs, docs, customer stories, 2025–2026) dos principais concorrentes de code review com IA. Marcação usada no texto: **[D]** = afirmado publicamente pela empresa; **[?]** = não documentado (inferência ou lacuna conhecida). As comparações de posicionamento são leitura qualitativa, **não** benchmark medido.
>
> *Observação:* "Maestro" **não** é uma ferramenta de code review — os produtos públicos com esse nome são outra coisa (orquestrador da Netflix, testing mobile, analytics de uso de IA). O produto com o perfil de reviewer é o **Ellie (Entelligence AI)**, não coberto neste levantamento.

---

## Resumo executivo

O gap em relação aos líderes (Greptile, CodeRabbit) **não é falta de peças**: já temos grafo AST, embeddings, um sistema de regras rico que **alimenta o agente** (Kody Rules + import de IDE multi-formato + memory rules) e aprendizado a partir de feedback. Os gaps são **arquiteturais e pontuais**, não de capacidade:

1. **Contexto:** o grafo AST existe (até persistido em banco), mas é **achatado no prompt** e **não é consultável como tool durante o loop** — os líderes traversam o grafo em multi-hop no runtime.
2. **Memória:** as regras *alimentam* o agente, mas o **loop de feedback não fecha sozinho** — 👍/👎 e implementado/ignorado são capturados e **não viram regra/supressão automática** (o Cursor faz isso continuamente).
3. **Verify:** validamos sintaxe/semântica, mas **não geramos "prova" executável** do finding antes de postar (CodeRabbit faz).

---

## Panorama por dimensão do harness

### 1. Topologia do agente

- **Concorrentes:**
  - **Anthropic (Claude):** *fleet* de agentes especializados rodando em paralelo + etapa de verificação. **[D]**
  - **Cubic:** planner → micro-agentes especializados → filtering agent. **[D]**
  - **CodeRabbit:** agentes Review / Verification / Chat / Pre-Merge em paralelo. **[D]**
  - **Cursor Bugbot:** migrou de pipeline fixo para **1 loop totalmente agêntico** + múltiplos modelos. **[D]**
- **Kodus (hoje):** **1 agente generalista** no caminho default. O trio Bug / Security / Performance existe no código, mas é exclusivo do modo `deep` e está **desligado** por padrão.
- **Diferença real:** estamos arquiteturalmente próximos do Cursor Bugbot atual (1 loop). A especialização **já existe** — está atrás do modo `deep`. É capacidade latente, não ausência.

### 2. Retrieval de contexto

- **Concorrentes:**
  - **Greptile:** **grafo do repositório + embeddings + memória**, consultados *durante* a review, com navegação multi-hop. **[D]**
  - **CodeRabbit:** **codegraph + LanceDB (embeddings) + 20–50 linters / ast-grep**. **[D]**
  - **Cubic:** **LSP** (go-to-definition / find-references) + terminal, em modelo *context-pulling*. **[D]**
- **Kodus (hoje):** temos **grafo AST** (`@kodus/kodus-graph`, 9 linguagens, índice persistido em banco) **e embeddings** (no fine-tuning). Porém:
  - o call graph é **achatado num bloco de texto injetado no prompt**;
  - o tool de navegação AST (`getCallers`) está **desabilitado**;
  - o agente explora por **grep / readFile textual**.
- **Diferença real:** não é "não temos grafo" — é que **o grafo não é consultável dentro do loop**. Eles traversam o grafo em multi-hop durante o raciocínio; nós despejamos um resumo estático no prompt e usamos o AST principalmente para validação da saída.

### 3. Verificação / anti-falso-positivo

- **Concorrentes:**
  - **Cubic:** **judge / filtering agent** + confidence 0–1 → redução reportada de **−51%** de falsos positivos. **[D]**
  - **CodeRabbit:** **verify agent gera scripts e "extrai prova do codebase antes de postar"**. **[D]**
  - **Anthropic:** *verification step* checa o candidato "contra o comportamento real do código". **[D]**
  - **Greptile:** confidence + supressão adaptativa. **[D]**
- **Kodus (hoje):** verify roda **AST parse + checkTypes (compilador nativo) + validação semântica por LLM**, com score de confidence 1–10 por finding.
- **Diferença real:** mesma intenção, mas **não materializamos "prova"** — o agente não gera um check direcionado para *provar* o defeito antes de postar. A infraestrutura (sandbox E2B + checkTypes) já existe; falta o passo de prova ativa.

### 4. Memória / aprendizado de reviews passados

- **Concorrentes:**
  - **Greptile:** **memória adaptativa** — contabiliza made / addressed / reactions, suprime categorias ignoradas 3×+ (*security nunca é suprimida*), e um sub-agent **recupera** da memory bank *durante* a review. **[D]**
  - **Cursor:** feedback vira **regras candidatas promovidas automaticamente** quando o sinal acumula (e auto-desativadas se performam mal), entrando no contexto do agente. **[D]**
- **Kodus (hoje) — temos bastante, e parte ALIMENTA o agente (não é só filtro):**
  - **Kody Rules (STANDARD)** injetadas no kody-rules agent; **Memory Rules** injetadas no prompt de **todos** os agentes (Bug/Security/Perf/Generalist). Isso *muda o que o agente procura*.
  - **IDE rules auto-sync:** ingerimos `.cursorrules`, `.cursor/rules/*.mdc`, `CLAUDE.md`, `.agents.md`, copilot-instructions, windsurf, aider e outros → viram regras injetadas. **Cobertura de formatos provavelmente maior que a dos concorrentes.**
  - **Geração de regras a partir de comentários de PRs históricos** (via LLM) — porém *one-time* / onboarding, não contínua.
  - **Kody Fine-Tuning:** filtro **pós-geração** por cluster de embeddings (👍/👎 + `IMPLEMENTED`) — esse sim roda **só no engine EE/legacy**, é **opt-in** e exige ≥ 50 sugestões históricas.
  - Sinais 👍/👎 e `implementationStatus` são **persistidos**.
- **Diferença real (corrigida — o gap é mais estreito do que parece):**
  1. **Não** é "eles alimentam o agente e nós só filtramos" — nós alimentamos o agente com regras (manuais + IDE-sync + geradas de histórico + memory). Em import de IDE somos provavelmente mais abrangentes.
  2. O gap genuíno: **o loop de feedback não é automático/contínuo.** 👍/👎 e implementado/ignorado são capturados, mas **não viram automaticamente regra nova nem supressão** para a próxima review. O Cursor fecha esse loop sozinho; nós dependemos de **humano ou re-rodar o onboarding**.
  3. Sub-diferença de arquitetura: nós **injetamos** as regras (com escopo por path) no prompt; o Greptile **recupera** da memory bank sob demanda no loop — escala melhor quando há muitas regras. Ambos *alimentam* o agente.

---

## Onde NÃO é desvantagem (é tradeoff)

- **1 generalista vs. multi-agente:** multi-agente consome ~Nx tokens. É uma escolha de custo — e o trio especializado já está pronto no código.
- **BYOK (Bring Your Own Key):** vantagem nossa. O cliente escolhe e usa o próprio modelo. Cursor e CodeRabbit **não nomeiam nem permitem escolher** o modelo. **[D/?]**
- **Sandbox E2B + validação AST da saída:** já entregamos checagem de sintaxe/semântica do patch antes de postar — algo que nem todos os concorrentes detalham publicamente.

---

## Frentes de maior ROI

Todas reusam infraestrutura que já existe:

1. **Ligar a memória no caminho do agente** e transformar padrões recorrentes em **Kody Rules** que o agente lê (estilo Cursor), pesando "implementado / ignorado" acima de reações 👍/👎.
2. **Reativar a navegação no grafo como tool do loop** (`getCallers` / `findReferences` sobre o índice AST já persistido em banco).
3. **Verify com prova ativa** — o agente gera um check no sandbox para confirmar o finding antes de postar (estilo CodeRabbit).

---

## Fontes (públicas)

**Anthropic / Claude**

- https://code.claude.com/docs/en/code-review
- https://code.claude.com/docs/en/github-actions
- https://github.com/anthropics/claude-code-security-review
- https://www.anthropic.com/engineering/built-multi-agent-research-system

**Greptile**

- https://www.greptile.com/blog/greptile-v3-agentic-code-review
- https://www.greptile.com/blog/greptile-v4
- https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context
- https://www.greptile.com/docs/how-greptile-works/memory-and-learning
- https://claude.com/customers/greptile

**Cursor Bugbot**

- https://cursor.com/blog/building-bugbot
- https://cursor.com/docs/bugbot
- https://cursor.com/blog/bugbot-learning
- https://cursor.com/blog/bugbot-autofix

**Cubic**

- https://www.cubic.dev/blog/learnings-from-building-ai-agents
- https://www.cubic.dev/blog/the-false-positive-problem-why-most-ai-code-reviewers-fail-and-how-cubic-solved-it
- https://docs.cubic.dev/ai-review/introduction

**CodeRabbit**

- https://docs.coderabbit.ai/overview/architecture
- https://www.coderabbit.ai/blog/pipeline-ai-vs-agentic-ai-for-code-reviews-let-the-model-reason-within-reason
- https://www.coderabbit.ai/blog/how-coderabbits-agentic-code-validation-helps-with-code-reviews
- https://cloud.google.com/blog/products/ai-machine-learning/how-coderabbit-built-its-ai-code-review-agent-with-google-cloud-run
