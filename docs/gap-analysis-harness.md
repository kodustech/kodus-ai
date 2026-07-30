# Gap-analysis do harness — Kodus vs estado da arte

> **Método.** Cruzamento entre (1) leitura do nosso código (harness do agente de code review) e (2) deep research sobre arquitetura de harness de agentes (papers + blogs, 2024–2026), com verificação adversarial de cada claim (3 votos; claims refutadas foram descartadas).
>
> **Marcação:** **[verificado]** = claim sobreviveu à verificação 3-voto; **[refutado]** = claim foi morta e **não** é usada como suporte; **[inferido]** = mapeamento do gap deduzido da descrição do nosso harness, não re-verificado contra o código nesta etapa (mas confirmado em leitura de código anterior).
>
> **Caveat dominante (ler antes dos números):** quase nenhuma fonte é benchmark de *PR code review*. As evidências vêm de domínios vizinhos — issue-resolution (SWE-bench), QA multi-hop, detecção de vulnerabilidade/static-analysis. **Os padrões transferem; os percentuais não.** Trate os ganhos como direcionais, não como delta previsto para o Kodus. Vários são preprints em benchmark próprio.

---

## Resumo da priorização

Ordenado por ROI (impacto × reuso de infra que já temos):

1. **Grafo de código consultável dentro do loop** — maior ROI: a infra (índice AST nodes/edges em banco) **já existe**, só não está exposta ao agente.
2. **Verify com prova executável/simbólica** — gap com respaldo peer-reviewed e bônus de robustez para BYOK; sandbox E2B já existe.
3. **Memória que aprende de falhas (não só de sucesso), recuperável no loop** — reposiciona o Kody Fine-Tuning de filtro pós-geração para guardrail recuperável.
4. **Camada crítica/judge sobre a saída + self-consistency cross-model** — FP-reducer documentado; complementa (não substitui) o item 2.

Nota de tempero: reabrir o trio temático Bug/Security/Perf **não** é claramente a jogada (ver "O que NÃO fazer").

---

## Gap 1 — Grafo de código consultável no loop (prioridade máxima)

- **O que o estado da arte mostra:**
  - Retrieval por similaridade (grep / BM25 / embedding) tem vantagem **quase nula** em código conectado por **arquitetura** (imports, herança, instanciação) em vez de similaridade textual. BM25 dá 78.2% vs 76.2% do baseline em tarefas de dependência oculta. **[verificado]**
  - Navegação em **grafo consultável** e **retrieval agêntico multi-hop** movem recall de forma grande: PRISM atinge 90.9% vs 61.5% (one-pass) no HotpotQA; CodexGraph/LocAgent motivam grafo consultável porque "retrieval por similaridade tem baixo recall em tarefas complexas". **[verificado]**
  - *Refutado e NÃO usado como suporte:* o número-manchete de 99.4% / +23.2pp / p&lt;0.001 do CodeCompass. **[refutado]**
- **Nosso estado (código):** temos um **índice AST repo-wide (nodes/edges) persistido em banco** (`graph-indexer.service.ts`), mas:
  - ele é **achatado e injetado como bloco de texto** `<CallGraph>` no prompt;
  - o tool de navegação AST (`getCallers`) está **desabilitado** (`agent-tools.factory.ts` — "agent never called it in 170+ runs");
  - a exploração no loop é **grep/readFile textual**. **[inferido]**
- **Por que é o maior ROI:** a infra cara (parsing, índice) **já está construída**. Falta expor como **tool consultável** (`getCallers` / `findReferences` / "quem chama X" / "quem implementa Y") para o agente traversar sob demanda.
- **Primeiro passo:** reativar `getCallers` sobre o índice já persistido + adicionar um tool de query no grafo; medir nº de tool-calls e mudança de recall em um conjunto de PRs.
- **Pergunta aberta:** embedding *denso* (≠ BM25 lexical) fecha o gap estrutural ou falha pela mesma razão? Não testado nas fontes.

---

## Gap 2 — Verify com prova executável/simbólica

- **O que o estado da arte mostra:**
  - A técnica de maior evidência para **reduzir falso-positivo** é uma camada de verificação **pós-geração ancorada em semântica de programa + checagem executável/simbólica** — não confidence de LLM.
  - LLM4PFA (path-feasibility → SMT/Z3): filtra **72–96% dos falso-positivos mantendo recall 0.93**; e é **robusto across backbones** (GPT-4o / Claude-Opus / Qwen / DeepSeek) — sinal direto de robustez para **BYOK**. **[verificado]**
  - RepoAudit (ICML 2025): validador por satisfatibilidade de path-condition → **78.43% de precisão**, 40 bugs reais, ~$2.54/projeto. **[verificado]**
- **Nosso estado (código):** verify roda **AST parse + checkTypes (compilador nativo) + validação semântica por LLM**, com confidence 1–10. **Não gera prova executável** do finding — é a abordagem mais fraca que a literatura supera. **[inferido]**
- **Reuso de infra:** o **sandbox E2B efêmero por review já existe** — é o lugar natural para o agente rodar um check direcionado (reproduzir o caminho, um teste mínimo, uma checagem de condição) antes de postar.
- **Primeiro passo:** num subconjunto de categorias com caminho de falha claro (null-deref, out-of-bounds, bugs de data-flow), fazer o agente gerar e rodar um check no sandbox que *confirme* o finding; comparar precisão vs o verify atual.
- **Pergunta aberta:** custo/latência de uma camada simbólica (estilo Z3) dentro do E2B por review, e quais categorias compensam.

---

## Gap 3 — Memória que aprende de falhas, recuperável no loop

- **O que o estado da arte mostra:**
  - ReasoningBank (ICLR): memória **recuperável em runtime** que destila estratégias de **sucessos E falhas** num loop fechado retrieve → extract → consolidate; falhas viram **guardrails preventivos**. Supera agentes sem memória em **+4.6% (SWE-bench-Verified)** e **+8.3% (WebArena)**. **[verificado]**
- **Nosso estado (código):** **temos aprendizado** (e ele alimenta o agente via Kody Rules / IDE-sync / memory rules). Mas o componente que usa feedback de outcome — **Kody Fine-Tuning** — é:
  - um **filtro pós-geração** (cluster k-means → KEEP/DISCARD por similaridade);
  - alimentado **principalmente por sucesso** (`IMPLEMENTED` + reações 👍/👎) — **não destila falhas/ignorados** em guardrail;
  - roda **só no engine EE/legacy** (não no agent path default), **opt-in**, exige ≥ 50 sugestões. **[inferido]**
- **A diferença real:** não é "falta memória" — é que **aprendemos quase só de sucesso, num filtro pós-geração, fora do path default.** Falta o sinal de **falha/ignorado** virar guardrail **recuperável dentro do loop**.
- **Primeiro passo:** capturar o sinal de "sugestão ignorada/rejeitada repetidamente" (já persistimos reações e `implementationStatus`) e destilar em guardrail recuperável no agent path — começando por um threshold de acúmulo (não agir em 1 voto) e **nunca suprimir security**.

---

## Gap 4 — Camada crítica/judge sobre a saída + self-consistency cross-model

- **O que o estado da arte mostra:**
  - GPTLens: separar **Auditor (alto recall, geração)** de um **Critic separado** que revisa, ranqueia e **filtra falso-positivos** bate detecção em um estágio. **[verificado]**
  - Cross-validation entre múltiplos LLMs (um valida o do outro) é FP-reducer documentado. **[verificado]**
  - *Refutado e NÃO usado como suporte:* que um "agente QA supervisório de relevância/coerência" seja componente *estabelecido* para orquestração de review. **[refutado]**
- **Nosso estado (código):** o trio `deep` é especialização **na geração**, não uma **camada crítica distinta** aplicada à saída do path default; não há voto **cross-model**. **[inferido]**
- **Complementaridade:** essa camada complementa o Gap 2 (prova) — o crítico decide *o que* verificar; a prova *confirma*.

---

## O que NÃO fazer (com base na pesquisa)

- **Não tratar o trio temático Bug/Security/Perf como "o" caminho.** A claim de que role-specialized review trios são padrão SOTA reconhecido foi **refutada** (1-2). O que é validado é **decompor + localizar bem + um revisor/crítico** — ou seja, investir em **localização (Gap 1)** e **crítico/verify (Gaps 2/4)**, não necessariamente em mais agentes temáticos.
- **Não confiar em confidence de LLM como verificação.** É a abordagem que a literatura supera (Gap 2).
- **Não citar números de outros domínios como delta previsto do Kodus.** São direcionais (ver caveat no topo).

---

## Pergunta aberta de maior valor

Existe **benchmark público de PR code review** (golden comments, precision/recall/resolution-rate — não issue-resolution estilo SWE-bench) que permita medir essas técnicas **direto no nosso caso**? Sem isso, todo ganho é direcional. Vale um passo dedicado de pesquisa, incluindo a metodologia de avaliação que CodeRabbit/Greptile/Bugbot/Cubic/Qodo/Korbit publicam ou implicam.

---

## Fontes (peer-reviewed e preprints)

**Orquestração / multi-agente**
- MAGIS — https://proceedings.neurips.cc/paper_files/paper/2024/file/5d1f02132ef51602adf07000ca5b6138-Paper-Conference.pdf · https://arxiv.org/abs/2403.17927
- Survey LLM multi-agente — https://arxiv.org/html/2404.04834v4

**Retrieval / grafo de código**
- CodeCompass — https://arxiv.org/html/2602.20048v1
- CodexGraph — https://arxiv.org/abs/2408.03910
- PRISM (retrieval multi-hop) — https://arxiv.org/pdf/2510.14278

**Verificação / redução de falso-positivo**
- LLM4PFA — https://arxiv.org/html/2506.10322
- RepoAudit (ICML 2025) — https://arxiv.org/pdf/2501.18160
- Estudo industrial híbrido LLM+static (Tencent) — https://arxiv.org/html/2601.18844v1
- GPTLens (via survey) — https://arxiv.org/abs/2310.01152

**Memória / aprendizado contínuo**
- ReasoningBank — https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/ · https://arxiv.org/abs/2509.25140

**Outros players / OSS**
- OpenHands CodeAct — https://www.openhands.dev/blog/openhands-codeact-21-an-open-state-of-the-art-software-development-agent
- Qodo (RAG para code review) — https://www.qodo.ai/blog/custom-rag-pipeline-for-context-powered-code-reviews/
- Baz Reviewer — https://baz.co/resources/baz-reviewer-one-more-step-towards-automated-code-review
