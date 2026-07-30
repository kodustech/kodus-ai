# Estudo sobre harness

## Defaults de um harness

Um *harness* é o scaffolding em volta do LLM — o código que transforma um modelo "cru" em um agente que executa uma tarefa de forma confiável. O modelo decide; o harness orquestra, dá ferramentas, monta contexto, verifica e aprende. (O termo vem de *test harness*: o arnês que segura e exercita o componente.) Por isso o harness é mais o **loop** do que qualquer outra coisa — não a infra de entrega (webhook, fila, posting) em volta dele.

Os harnesses de propósito geral que resolveram edição de código em repositório real (Claude Code, Cursor, Codex, e abertos como o Hermes/Nous) convergiram, de forma independente, num mesmo conjunto de componentes. A Arize sistematizou isso num **modelo de referência de 9 componentes** — útil como checklist do que um harness "completo" tem:

1. **Loop de iteração (outer loop).** O ciclo: montar prompt → chamar o modelo → emite *tool-call* ou *done* → executar a tool → realimentar o resultado → repetir até parar (`stopWhen`: *done-tool* ou teto de passos). É a fundação — o resto orbita isso.
2. **Gestão e compressão de contexto.** O que entra no contexto, o que é resumido/podado quando a janela enche, como dados grandes são representados de forma enxuta.
3. **Gestão de tools/skills.** Registro de ferramentas + decisão de *quais* o modelo vê em cada run (menos tools e mais focadas dá mais confiabilidade; toolkit grande causa "decision paralysis"). "Skills" = camada de conhecimento do time por cima das tools.
4. **Gestão de subagentes.** Spawnar agentes-filhos isolados (sessão própria, tools restritas, prompt focado) e coletar o resultado, sem corromper o contexto do pai.
5. **Skills pré-empacotadas.** Capacidades que vêm de fábrica (ler/editar arquivo, shell, navegação de código; e mais alto nível: commit, abrir PR, rodar testes).
6. **Persistência e recuperação de sessão.** Gravar o estado em disco (JSONL/SQLite append-only) para resumir de onde parou após crash.
7. **Montagem do system prompt / injeção de contexto do projeto.** Compor o prompt dinamicamente: instruções (CLAUDE.md/AGENTS.md/.cursorrules), git status, metadados de ambiente, lista de tools — tudo com orçamento de tokens.
8. **Lifecycle hooks.** Pontos de extensão antes/depois de uma tool (allow/deny/rewrite, auditoria, política) que rodam independente da cooperação do modelo.
9. **Camada de permissão e segurança.** O que o agente pode fazer, enforçado a cada execução (read-only / workspace-write / full), com aprovação interativa e regras allow/deny.

> *Framework proposto pela Arize ("What is an Agent Harness"); é leitura de mercado, não peer-reviewed.* A esses 9 somam-se duas preocupações operacionais que um harness maduro também tem (e que nós já cobrimos): **observabilidade/tracing por turno** (no nosso caso, Langfuse) e **budget/throttle** (no nosso caso, o limitador de concorrência BYOK).

**Para um harness de *code review*, dois ajustes neste modelo:**

* **Nem tudo pesa igual.** Review é *efêmero* (uma passada por PR, sem conversa longa), então persistência/recuperação de sessão (6), subagentes duráveis (4) e lifecycle hooks (8) importam bem menos que num agente de coding interativo. O que **domina** o resultado de um reviewer é: loop (1), gestão/retrieval de contexto (2) e tools (3).
* **Review adiciona dois componentes que o modelo geral não destaca** — e é justamente onde moram nossos gaps:
  * **Verificação / anti-falso-positivo:** o filtro entre "o agente achou" e "o dev vê" — confidence, *judge/critic agent*, voto cross-model, ou o mais forte: **prova executável** do achado antes de postar.
  * **Memória de feedback:** aprender de reviews passadas (regras manuais/importadas/geradas, *memory bank* recuperável, supressão/promoção por feedback). O sinal mais valioso é aprender de **sucesso e de falha**, não só do que deu certo.

## Code Review Harness

### Nosso harness hoje (o loop)

No caminho default, o Kodus roda **1 agente generalista** agêntico. O loop (`runAgentLoop`, sobre o `generateText` multi-step do AI SDK):

* **Parada (`stopWhen`):** chamada do *done-tool* `submitResult` **ou** teto de passos (`maxSteps` = 20 em normal, 100 em deep; *fast* é capado).
* **A cada passo:** o modelo ou chama uma **tool** (executada no sandbox E2B, com o resultado realimentado no histórico) ou chama `submitResult` (encerra).
* **Tools no loop:** `grep`, `readFile`, `listDir` (textuais), `checkTypes` (compilador nativo), `readReference`, `searchDocs`. O tool de navegação AST (`getCallers`) está **desabilitado**.
* **`prepareStep`** (antes de cada passo): comprime o contexto se perto da janela, injeta *step-budget* e *coverage-debt*, e nos 2 últimos passos faz *force-text* (remove tools e exige a saída em JSON).
* **Saída:** findings em JSON (com fallback de estruturação por modelo barato) → passo de **verify** (AST parse + `checkTypes` + validação semântica por LLM, confidence 1–10) → sugestões.
* **Em volta:** o *orchestrator* faz fan-out paralelo dos agentes (no default, só o generalista; o trio Bug/Security/Perf é exclusivo do modo `deep`); *wrappers* de timeout (30 min), throttle de concorrência BYOK, *preflight* de janela de contexto e *coverage ledger*.

O resto desta seção compara esse harness com o dos concorrentes e mapeia os gaps.

### Diferenças em relação aos concorrentes (dados públicos)

Escopo e método. Levantamento feito sobre material público (engineering blogs, docs, customer stories, 2025–2026) dos principais concorrentes de code review com IA. Marcação usada no texto: [D] = afirmado publicamente pela empresa; [?] = não documentado (inferência ou lacuna conhecida). As comparações de posicionamento são leitura qualitativa, não um benchmark medido.

O gap em relação aos líderes (Greptile, CodeRabbit) não é falta de peças: já temos grafo AST, embeddings e aprendizado a partir de feedback. O gap é arquitetural — essas peças estão fora do loop que roda por padrão, ou são usadas de forma estática (dump no prompt / filtro pós-geração) em vez de consultáveis e realimentadas durante o raciocínio do agente.

#### Panorama por dimensão do harness

#####  1. Topologia do agente

* Concorrentes:
  * Anthropic (Claude): fleet de agentes especializados rodando em paralelo + etapa de verificação. [D]
  * Cubic: planner → micro-agentes especializados → filtering agent. [D]
  * CodeRabbit: agentes Review / Verification / Chat / Pre-Merge em paralelo. [D]
  * Cursor Bugbot: migrou de pipeline fixo para 1 loop totalmente agêntico + múltiplos modelos. [D]
* Kodus (hoje): 1 agente generalista no caminho default. O trio Bug / Security / Performance existe no código, mas é exclusivo do modo deep e está desligado por padrão.

##### 2. Retrieval de contexto

* **Concorrentes:**
  * **Greptile:** **grafo do repositório + embeddings + memória**, consultados *durante* a review, com navegação multi-hop. **[D]**
  * **CodeRabbit:** **codegraph + LanceDB (embeddings) + 20–50 linters / ast-grep**. **[D]**
  * **Cubic:** **LSP** (go-to-definition / find-references) + terminal, em modelo *context-pulling*. **[D]**
* **Kodus (hoje):** temos **grafo AST** (`@kodus/kodus-graph`, 9 linguagens, índice persistido em banco) **e embeddings** (no fine-tuning). Porém:
  * o call graph é **achatado num bloco de texto injetado no prompt**;
  * o tool de navegação AST (`getCallers`) está **desabilitado**;
  * o agente explora por **grep / readFile textual**.

**Diferença real:** não é "não temos grafo" — é que **o grafo não é consultável dentro do loop**. Eles traversam o grafo em multi-hop durante o raciocínio; nós despejamos um resumo estático no prompt e usamos o AST principalmente para validação da saída.

##### 3. Verificação / anti-falso-positivo

* **Concorrentes:**
  * **Cubic:** **judge / filtering agent** + confidence 0–1 → redução reportada de **−51%** de falsos positivos. **[D]**
  * **CodeRabbit:** **verify agent gera scripts e "extrai prova do codebase antes de postar"**. **[D]**
  * **Anthropic:** *verification step* checa o candidato "contra o comportamento real do código". **[D]**
  * **Greptile:** confidence + **supressão adaptativa** (*Adaptive Noise Filtering*). **[D]**
* **Kodus (hoje):** verify roda **AST parse + checkTypes (compilador nativo) + validação semântica por LLM**, com score de confidence 1–10 por finding.

> **O que é "supressão adaptativa" (Greptile):** o sistema mantém contadores por *categoria/tipo* de sugestão — ex. `{ made: 10, addressed: 0, reactions: -3 }` (quantas vezes emitiu aquele tipo, quantas foram endereçadas, saldo de reações). Quando uma categoria é **repetidamente ignorada (3×+) ou recebe downvotes**, ela passa a ser **automaticamente suprimida** nas próximas reviews — sem humano no meio. Sinais que alimentam: 👍/👎, replies dos devs e **análise commit-inicial vs commit-final** (o que de fato foi corrigido até o merge). Safeguard: *security nunca é suprimida*. Resultado alegado: ~80% menos comentários ignorados, 3× mais adoção. **[D]** Contraste com o nosso Kody Fine-Tuning: lá é por *categoria*, automático e contínuo; o nosso é por *similaridade de cluster* (embedding), pós-geração e só no engine EE.

**Diferença real:** mesma intenção, mas **não materializamos "prova"** — o agente não gera um check direcionado para *provar* o defeito antes de postar. A infraestrutura (sandbox E2B + checkTypes) já existe; falta o passo de prova ativa.

##### 4. Memória / aprendizado de reviews passados

- **Concorrentes:**
  - **Greptile:** **memória adaptativa** — contabiliza made / addressed / reactions, suprime categorias ignoradas 3×+ (*security nunca é suprimida*), e um sub-agent **recupera** da memory bank *durante* a review. **[D]**
  - **Cursor:** feedback vira **regras candidatas promovidas automaticamente** quando o sinal acumula (e auto-desativadas se performam mal), entrando no contexto do agente. **[D]**
- **Kodus (hoje) — temos bastante, e parte ALIMENTA o agente (não é só filtro):**
  - **Kody Rules (STANDARD)** injetadas no kody-rules agent; **Memory Rules** injetadas no prompt de **todos** os agentes (Bug/Security/Perf/Generalist). Isso *muda o que o agente procura*.
  - **IDE rules auto-sync:** ingerimos `.cursorrules`, `.cursor/rules/*.mdc`, `CLAUDE.md`, `.agents.md`, copilot-instructions, windsurf, aider e outros → viram regras injetadas. **Cobertura de formatos provavelmente maior que a dos concorrentes.**
  - **Geração de regras a partir de comentários de PRs históricos** (via LLM) — porém *one-time* / onboarding, não contínua.
  - **Kody Fine-Tuning:** filtro **pós-geração** por cluster de embeddings (👍/👎 + `IMPLEMENTED`) — esse sim roda **só no engine EE/legacy**, é **opt-in** e exige ≥ 50 sugestões históricas.
  - Sinais 👍/👎 e `implementationStatus` são **persistidos**.

**Diferença real:**

1. **Não** é "eles alimentam o agente e nós só filtramos" — nós alimentamos o agente com regras (manuais + IDE-sync + geradas de histórico + memory). Em import de IDE somos provavelmente mais abrangentes.
2. O gap genuíno: **o loop de feedback não é automático/contínuo.** 👍/👎 e implementado/ignorado são capturados, mas **não viram automaticamente regra nova nem supressão** para a próxima review. O Cursor fecha esse loop sozinho; nós dependemos de **humano ou re-rodar o onboarding**.
3. Sub-diferença de arquitetura: nós **injetamos** as regras (com escopo por path) no prompt; o Greptile **recupera** da memory bank sob demanda no loop — escala melhor quando há muitas regras. Ambos *alimentam* o agente.

#### Onde NÃO é desvantagem (é tradeoff)

* 1 generalista vs. multi-agente: multi-agente consome ~Nx tokens. É uma escolha de custo — e o trio especializado já está pronto no código.
* BYOK (Bring Your Own Key): vantagem nossa. O cliente escolhe e usa o próprio modelo. Cursor e CodeRabbit não nomeiam nem permitem escolher o modelo [D/?].
* Sandbox E2B + validação AST da saída: já entregamos checagem de sintaxe/semântica do patch antes de postar — algo que nem todos os concorrentes detalham publicamente.

#### Frentes de maior ROI

Todas reusam infraestrutura que já existe:

1. **Ligar a memória no caminho do agente** e transformar padrões recorrentes em **Kody Rules** que o agente lê (estilo Cursor), pesando "implementado / ignorado" acima de reações 👍/👎.
2. **Reativar a navegação no grafo como tool do loop** (`getCallers` / `findReferences` sobre o índice AST já persistido em banco).
3. **Verify com prova ativa** — o agente gera um check no sandbox para confirmar o finding antes de postar (estilo CodeRabbit).

### Estado da arte (pesquisa acadêmica)

Achados de uma pesquisa em papers e blogs técnicos (2024–2026), com verificação adversarial de cada claim. Marcação: [verificado] = sobreviveu à checagem; [refutado] = claim morta, não usada como suporte; [inferido] = mapeamento do nosso gap deduzido do harness, confirmado em leitura de código.

**Caveat dominante:** quase nenhuma fonte é benchmark de *PR code review* — vêm de domínios vizinhos (issue-resolution / SWE-bench, QA multi-hop, detecção de vulnerabilidade). **Os padrões transferem; os percentuais não.** Trate os ganhos como direcionais.

A literatura converge em **quatro jogadas** que movem métrica. Todas foram verificadas; os dois pontos marcados como refutados são alertas do que **não** concluir.

#####  1. Dividir o trabalho entre agentes ganha de um agente só

* **A ideia:** em vez de um LLM resolver tudo numa tacada, dividir em **papéis** — quem planeja, quem acha o lugar certo no código, quem escreve, quem revisa — entrega muito mais.
* **A evidência:** o sistema MAGIS resolveu **8× mais** problemas que o GPT-4 sozinho (13.94% vs 1.74% num benchmark de bugs reais). E o fator que mais pesou no acerto foi **achar o trecho certo do código** (localização).
* **Cuidado — o que NÃO é validado:** dividir por **tema** (um agente de bug, um de security, um de perf) não é o que a pesquisa endossa. O que funciona é dividir por **função**: planejar → localizar → revisar. Ou seja, nosso trio temático do modo `deep` não é a aposta certa.
* *Fonte: MAGIS (NeurIPS 2024).*

#####  2. Deixar o agente NAVEGAR o código, não só buscar por texto — nosso maior gap

* **A ideia:** procurar arquivos por "parecença de texto" (grep, palavra-chave, embedding) quase não ajuda quando o que importa está ligado por **estrutura** (quem importa quem, quem herda de quem). Aí o agente precisa **seguir as conexões** do código.
* **A evidência:** busca textual praticamente empata com não buscar nada (78% vs 76%). Já deixar o agente seguir as conexões em vários saltos sobe muito o quanto ele encontra do que importa (de ~62% para ~91% num teste de referência).
* **Nosso gap:** a gente **já tem o mapa do código** (grafo AST de quem-chama-quem) salvo no banco — mas o agente **não consegue consultar esse mapa durante a review** (só jogamos um resumo no prompt), e o tool que faria isso (`getCallers`) está **desligado**. Como a infra já existe, é o gap de **melhor custo-benefício**.
* *Fonte: CodeCompass, PRISM, CodexGraph/LocAgent. (Um número exagerado do CodeCompass foi descartado na verificação — vale a direção, não o número.)*

#####  3. Provar o bug rodando uma checagem, não só "confiar" na nota do modelo

* **A ideia:** a forma mais eficaz de cortar falso-positivo é, depois que o modelo aponta um bug, **rodar uma checagem que confirme que aquele caminho de erro é possível de verdade** — em vez de só pedir uma nota de confiança ao próprio modelo.
* **A evidência:** uma técnica que confirma o caminho do bug com um provador matemático **cortou 72–96% dos falso-positivos sem perder os bugs reais**, e funcionou bem com vários modelos diferentes (importante pro nosso **BYOK**). Outra abordagem parecida chegou a ~78% de precisão.
* **Nosso gap:** hoje validamos com compilador + uma segunda opinião do LLM + nota 1–10 — que é justamente a **abordagem mais fraca** que esses trabalhos superam. E a gente **já tem o sandbox (E2B)** pra rodar a prova.
* *Fonte: LLM4PFA, RepoAudit (ICML 2025).*

#####  4. Aprender também com o que deu ERRADO, e consultar isso durante a review

* **A ideia:** uma memória que guarda lições tanto dos **acertos quanto dos erros**, que o agente **consulta na hora da review** — e usa os erros para criar "não cometa de novo".
* **A evidência:** agentes com esse tipo de memória foram **+4,6% e +8,3%** melhores que sem memória, em benchmarks de software e web.
* **Nosso gap:** nosso aprendizado (Kody Fine-Tuning) usa quase só o que deu **certo** (sugestão implementada + 👍), é um **filtro depois** que o agente já gerou, e **nem roda no caminho default**. Falta transformar o "ignoraram / rejeitaram" em lição que o agente **consulta dentro do loop**.
* *Fonte: ReasoningBank (ICLR).*

#####  Caso real de produção: scaling + verificação adversarial (Ramp)

A Ramp apontou ~10.000 agentes de código (uma sessão por endpoint, cada uma num sandbox com ambiente de dev real) no próprio backend para caçar vulnerabilidades. Pipeline: **scan → dedup → confirmação**. Achou 7 vulnerabilidades high-sev novas que pen-tests, bug bounty e scans anteriores não pegaram. Três lições que transferem pro nosso harness:

* **Mais de uma passada nas superfícies críticas (best-of-N).** Para *achar* bug, basta UMA trajetória acertar entre muitas — a taxa de sucesso escala log-linear com o nº de tentativas (Large Language Monkeys, ICLR 2025). *Caveat honesto:* a economia de 10k passes funciona para auditar o codebase inteiro; por-PR (diff pequeno, custo por PR) não dá para spammar — transfere como "passes extras em auth/payments/diffs sensíveis", não milhares.
* **Prova no sandbox (reforça nosso gap de verify).** Cada agente reproduz o bug end-to-end (faz request real, roda teste) *antes* de filar o ticket. É exatamente a "prova executável" da jogada 3 — e a infra (E2B) já temos.
* **Confirmação adversarial — "argue against yourself".** Um passe final regrada a severidade com um prompt que manda o agente *argumentar contra o próprio achado* ("garanta que a arquitetura / escopo já não torna esse ataque inalcançável ou irrelevante"). Combate a superestimação (todo modelo testado inflava severidade). É barato e plugável no nosso verify.

Bônus pro **BYOK**: rodaram em GPT-5.5, mas modelos abertos ~5× mais baratos (Kimi K2.6, DeepSeek V4 Pro) ainda acharam high-sev em taxa relevante — evidência real de que um reviewer com modelo aberto é viável.

> *Marcação: case study público da Ramp (produção, recente). Não é benchmark de PR-review — é auditoria de codebase inteiro — mas é o exemplo mais próximo do nosso domínio na lista.*

#####  Caveat (ler junto com os números acima)

Quase nenhuma dessas fontes é benchmark de **PR code review** — vêm de domínios vizinhos (resolver issues, busca multi-hop, detecção de vulnerabilidade). **As ideias transferem; os percentuais não.** Trate os ganhos como **direção**, não como o número que o Kodus vai bater.

#####  Pergunta aberta de maior valor

Existe um **benchmark público de PR code review** (com comentários "gabarito", medindo precisão/recall) que deixe a gente testar essas técnicas **direto no nosso caso**? Sem isso, todo ganho é estimativa. Vale um passo dedicado de pesquisa.

### Recall: achar bugs sem deixar passar (nosso principal gap)

Quase todo o estudo acima é sobre **precisão** (cortar falso-positivo). A outra metade da qualidade é **recall**: estamos deixando passar bug real? Esta seção vem de uma pesquisa focada só em recall, com verificação adversarial de cada claim.

> **Caveat dominante:** a maioria das evidências vem de *localização de issue* (achar o arquivo/função a editar) ou *classificação de vulnerabilidade* em datasets rotulados — **não** de detecção de bug em PR-review. Os **mecanismos transferem; os números não.** E o limite mais importante: vários ganhos abaixo dependem de um **verificador automático** (ex. teste unitário), que PR-review **não tem**.

> **O que é "oráculo" / verificador automático.** Um juiz que diz, **sozinho e com certeza, se uma resposta está certa** — sem humano. Exemplos: rodar o **teste unitário** (passou = certo), comparar com o **gabarito** de matemática, **compilou ou não**. É o que faz o best-of-N funcionar: você gera N tentativas e o oráculo **filtra automaticamente** quais prestam. **Code review não tem isso:** dizer se "null-pointer na linha 42" é bug real exige *julgamento* (o caminho é alcançável? a intenção era essa?), não um verde/vermelho automático. Consequência: sem oráculo, gerar muitas passadas e juntar tudo **acha mais bug real, mas junta lixo na mesma proporção** — o recall sobe na teoria, mas é **inútil** porque afoga o dev em falso-positivo. "Recall útil" = bug real que chega ao dev **sem** estar enterrado em ruído.

Recall tem **três alavancas** independentes:

#####  1. Localização via grafo consultável (maior ROI, reusa nossa infra)

* **A ideia:** deixar o agente **seguir as conexões do código** (quem chama / importa / herda) em vez de buscar por texto. Bug costuma estar agrupado perto de código relacionado, e o trecho certo muitas vezes fica logo abaixo do corte da busca por similaridade.
* **A evidência:** localização por grafo chega a **92.7%** vs ~62% (busca textual) e ~80% (embedding); expandir pelos vizinhos do grafo sobe o recall em **≥13% sem gastar mais budget** de exploração.
* **Nosso gap:** o grafo AST **já está no banco**, mas **não é consultável no loop** e o `getCallers` está **desligado** — exploramos por grep textual.
* **Atenção honesta:** isso é comprovado para *localização* (achar onde editar), não para *detecção de bug*. Há evidência de que localização hierárquica sem navegação agêntica empata com a agêntica — então **religar o `getCallers` precisa de A/B nosso** (grafo on vs off no golden set) para confirmar que sobe recall de detecção.
* *Fonte: [LocAgent](https://arxiv.org/abs/2503.09089), [SpIDER](https://arxiv.org/abs/2512.16956), [RepoLens](https://arxiv.org/abs/2509.21427); [Agentless](https://arxiv.org/abs/2407.01489) (o contraponto).*

#####  2. Mais passadas / combinar modelos (cobertura) — só vale com filtro bom

* **A ideia:** modelos diferentes (e até execuções diferentes do mesmo modelo) acham bugs **diferentes**; juntar a **união** dos achados sobe a cobertura. E quanto mais tentativas, mais bugs aparecem.
* **A evidência:** a cobertura escala **log-linear** com o nº de passadas — um modelo fraco com 250 passadas (56%) **bateu** o modelo forte de uma passada só (43%). Ensembles de modelos diversos deram **+18–34% de recall** em detecção de vulnerabilidade, com o maior ganho nos casos multi-arquivo.
* **Restrição dura:** esses ganhos só viram finding útil quando existe um **verificador automático** (ex. teste unitário). **PR-review não tem esse oráculo** — sem um filtro de precisão calibrado, juntar tudo só **infla falso-positivo**.
* **Nosso gap:** hoje é **1 passada, sem ensemble**. A alavanca existe (BYOK + E2B), mas é **refém da alavanca 3** (o filtro) estar bom primeiro.
* *Fonte: [Large Language Monkeys](https://arxiv.org/abs/2407.21787); ensembles de vuln-detection — [multi-role](https://arxiv.org/abs/2403.14274), [DVDR-LLM](https://arxiv.org/abs/2512.12536), [boosting/ensembling](https://arxiv.org/abs/2509.12629).*

#####  3. Nosso verify pode estar MATANDO bug real

* **A ideia:** gerar-amplo-depois-filtrar só **sobe** recall se o filtro **acerta mais do que erra**. Threshold de confiança/consenso alto demais derruba true-positive (sobe falso-negativo).
* **A evidência:** prova formal de que o filtro só ajuda se a taxa de acerto > taxa de erro; e consenso de alto acordo comprovadamente **abaixa** recall em detecção.
* **Nosso gap:** o descarte por baixa confiança do nosso verify **provavelmente está jogando fora bug real**. Recalibrar: só descartar um finding quando o filtro for comprovadamente confiável.
* *Fonte: [SpIDER](https://arxiv.org/abs/2512.16956) (prova), [DVDR-LLM](https://arxiv.org/abs/2512.12536).*

#####  4. Caçar cada classe de bug separadamente — testar, não assumir

* **A ideia:** hoje o default é **um generalista** que procura "qualquer bug". O risco: ele pode **nunca procurar uma classe inteira** (ex. concorrência) e zerar o recall dela **sem ninguém notar** — não aparece finding nenhum. Especializar por classe (ou ligar o trio `deep`: Bug/Security/Perf) é candidato a garantir que cada categoria seja olhada.
* **Status:** é **hipótese, não aposta.** Existem papers afirmando que "agentes especializados acham *provadamente* mais bugs" — mas essas afirmações foram **refutadas** na verificação adversarial (levaram 0-3). O que sobrou só **sugere** (modelos diferentes acham bugs diferentes), não prova.
* **Para nós:** não usar "especializar sobe recall" como justificativa para ligar o trio `deep`. Tratar como **experimento a medir** no `golden_comments` (recall por classe), não como ganho garantido.

#####  Como medir recall (já temos a peça)

* O **benchmark `golden_comments`** (136 comentários-gabarito, 50 PRs) **já é** um instrumento de recall: rastrear **miss-rate (1 − recall@golden)** ao longo do tempo e **por classe de bug** — para achar as classes que o generalista nunca caça.
* **Injeção de bug sintético** (mutation) por classe → detection-rate por classe.
* **Coverage-ledger emitir a "fração examinada" por PR** → separar recall perdido em arquivo *não examinado* vs perdido em arquivo *examinado*.
* *Caveat:* o golden-set é a **única** medida direta de PR-review; Defects4J / CVE / SWE-bench são domain-transfer.

#####  A ordem certa

1. **Medir primeiro:** qual o nosso recall@golden hoje, por classe e por tamanho de PR? Sem baseline, todo ranking de ROI é chute.
2. **Tier 1:** grafo consultável + **garantia de cobertura** (todo arquivo/hunk alterado examinado); checar se `maxSteps=20` corta exploração em PR grande.
3. **Tier 2:** **recalibrar o verify** (parar de matar TP) e só então testar mais passadas / união — que dependem do filtro estar calibrado.

#####  O que NÃO fazer (recall)

* Não tratar o trio especializado como ganho garantido de recall (refutado).
* Não achar que consenso/voto sempre ajuda — é **tradeoff** e frequentemente **abaixa** recall.
* Não portar best-of-N como ganho grátis — sem oráculo, infla falso-positivo.

### Custo / viabilidade (lente de priorização)

Qualidade é só um eixo; **custo** é o outro — e no nosso caso **BYOK** ele inverte a conta: o **cliente paga cada token**, então técnica que multiplica token pesa no bolso *dele* e pode inviabilizar BYOK com modelo caro. Esta seção vem de uma pesquisa focada em custo/latência, com verificação adversarial.

> **Caveat:** quase toda evidência quantitativa é de math/reasoning, **não code review** — use como direção e ordem de grandeza, não como número transferível. Valores "até X%" são best-case (cenário idealizado).

#####  Custo das técnicas que movem qualidade (da mais cara à mais barata)

* **Trio multi-agente — a mais cara.** Agente ≈ 4× tokens de chat; multi-agente ≈ 15× → o trio é **~3.75× sobre o generalista atual**. E a **própria Anthropic diz que multi-agente NÃO compensa para a maioria das tarefas de código** (contexto compartilhado, dependências). → argumento direto para **manter o trio desligado no default**. [verificado]
* **Best-of-N / ensemble — ~N× output + chamada do juiz**, escala linear em N. E (ver seção Recall) **sem oráculo não vira recall útil** → caro *e* travado para nós. **Baixa prioridade em BYOK.** [verificado]
* **Grafo consultável (Tier-1 de recall) — barato.** Adiciona tool-calls/steps, **não multiplica passadas**. A maior alavanca de recall é também das mais baratas. [inferido]
* **Prova no sandbox — pesa em *compute*, não em token.** Diferente do trio e do best-of-N (que gastam tokens de LLM), rodar um check no sandbox (E2B) para confirmar um finding gasta **CPU / RAM / tempo**. Em BYOK isso é **bom**: não infla a fatura de token do cliente — o custo vira **infra que nós hospedamos**. Para dimensionar essa infra: um concorrente (CodeRabbit) usa ~**1 vCPU + 4 GiB por review rodando em paralelo**. [verificado, infra de concorrente]
* *Fonte: [Anthropic multi-agent](https://www.anthropic.com/engineering/built-multi-agent-research-system); [best-of-N](https://arxiv.org/abs/2503.01422); [CodeRabbit/Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/how-coderabbit-built-its-ai-code-review-agent-with-google-cloud-run).*

#####  Alavancas de redução de custo (quase tudo já temos)

* **Prompt caching — a mais sólida, já está na nossa infra.** Realista em multi-turn: **−53% custo / −75% latência**; produção independente ~59-70% a **~74% de hit rate**. Read = 10% do input, write = +25%. Frágil em loop agêntico (mudança no meio do prefixo invalida; TTL 5min). → **medir nosso cache hit rate real é open question.** [verificado]
* **Model routing / cascade — adicionar.** Modelo barato primeiro, escala pro caro só quando um scorer indica. Faixa defensável **50-73%** de economia (98% é só headline). Depende de um **scorer de escalonamento barato e confiável**. [verificado]
* **Roteamento adaptativo por dificuldade** bate best-of-N com 2-4× menos compute, mas o sinal publicado é caro — **a gente já tem um proxy** (tamanho/risco do diff no `adaptive-fit` / `file-priority-scorer`); estender. [verificado]
* **Compressão de contexto + diff-scoping** — já temos.
* *Fonte: [Anthropic prompt-caching](https://www.anthropic.com/news/prompt-caching); [FrugalGPT](https://arxiv.org/abs/2305.05176); [test-time compute / latência](https://arxiv.org/abs/2509.09864).*

#####  O ponto-chave do BYOK

Concorrentes **embutem o modelo e cobram por seat** (CodeRabbit Pro $24/user/mês, PRs ilimitados). Nós: **cliente paga cada token.** Logo, técnicas N× (trio, best-of-N, ensemble) **multiplicam a fatura do cliente**. **Regra:** preferir alavancas que **cortam token** (caching, cascade, compressão, diff-scoping) sobre as que **multiplicam inferência**. [verificado]

#####  Token ≠ latência

São eixos distintos: best-of-N / majority-voting **paralelizam** (latência cresce pouco com N **se houver slots** — limitado pelo nosso throttle BYOK); beam search serializa. Otimizar custo (tokens) e latência (wall-clock) são decisões separadas. [verificado]

#####  Como medir custo (não temos)

Não temos **$/review** nem **$/finding** atribuído por review. Instrumentar no Langfuse: tokens (input / cache-write / cache-read / output) × preço do provider, por review, dividido por findings. Sem isso, a conta é cega.

#####  O que NÃO usar (mortos na verificação / inaplicável)

* "$15-25/review da Anthropic" e "review escala 20-30min com o tamanho do PR" — **refutados**.
* "token explica 80% da variância de performance" — **refutado**.
* **ST-BoN** (−70-80% compute): **inaplicável** ao nosso caso — exige hidden states de modelo self-hosted, não roda em API fechada (Anthropic/OpenAI/Gemini).

#####  Conclusão: custo reforça a ordem

A lente de custo **não muda** a prioridade — **reforça**: (1) **grafo consultável** sobe recall **sem multiplicar token** → segue como #1 (barato + alto impacto); (2) **caching + cascade + budget adaptativo** = onde mora a economia, e reusa infra nossa; (3) **trio / best-of-N / ensemble = caros pro cliente** e (best-of-N) travados sem oráculo → **baixa prioridade em BYOK**.
