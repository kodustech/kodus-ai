# Matrix Gaps — Root Causes da Semana 2026-07-06→13 e Plano de Testes

Investigação profunda dos bugs/regressões da última semana + feedbacks de clientes
(Physitrack/Michał, cliente do experimento `.kody/rules` 42%, cliente BYOK que pausou).
Objetivo: entender causa raiz, por que a matriz/testes não pegaram, e o que criar.

---

## 1. O que quebrou (causas raiz)

### 1.1 Kody Rules silenciosamente não avaliadas (múltiplos bugs empilhados)

| Bug | Causa raiz | Fix |
|---|---|---|
| Multi-glob quebrado | Importer persistia `path: ["app/**","lib/**"]` comma-joined numa string; picomatch tratava `,` como literal → regra casava zero arquivos. Explica o "all-or-nothing por rule file" (42% recall do cliente) | #1494 — `splitRulePathGlobs()` em `libs/common/utils/kody-rules/file-patterns.ts:183` |
| UUIDs corrompidos | Judge pedia eco de UUID 36-chars; exact-match descartava violações com 1-2 chars errados | #1521 — índices 1-based (`kody-rules-sharded.judge.ts:375`) |
| **Wire schema OpenAI-strict** | Regressão de `3448cf74a` (10/jul "Fixing models", NÃO do #1480): migração p/ `runStructuredReviewCall` + `structuredOutputs: true`; zod `.optional()` → `required` incompleto → **400 em todo shard antes do modelo rodar**, só em orgs BYOK-OpenAI. Engolido por `catch { shardsErrored++ }` sem log (judge.ts:304/326 pré-fix) | #1523 (falhou — teste re-derivava o schema localmente), #1525 (schema hand-authored), #1526 (`zodToStrictWireSchema` central em `libs/llm/strict-wire-schema.ts`). Janela ~30h, QA only |
| AGENTS.md invisível | `RULE_FILE_PATTERNS` só tinha dotfiles `.agents.md`/`.agent.md` | #1494 — `file-patterns.ts:18` |
| Só root CLAUDE.md | Discovery root-anchored, sem traversal | #1494 — `RULE_FILE_DISCOVERY_PATTERNS` + scoping por subdir |
| Case-sensitivity split | PR-sync case-sensitive, full-sync insensitive → `claude.md` lowercase sincronizava num path e não no outro | #1494 — `isFileMatchingGlobCaseInsensitive` em ambos |
| @-refs não resolvidos | Código não existia | #1494 — `inlineAtFileReferences()` (`kodyRulesSync.service.ts:1967`), **depth 1, máx 5 refs, 100KB** |
| Conteúdo reescrito no import | Todo import passava por LLM sem contrato de fidelidade (Bad/Good cortados, `**NAME1**` stripped) | #1494 — parser determinístico `kody-rule-file-parser.ts`, **verbatim só p/ `.kody/rules/**` e `rules/**/*.md`** |
| Rules stale ressuscitando | `findRuleBySourcePath` (`Array.find`) sem ordering deletedAt/recency | #1494 — newest-non-deleted |
| Self-hosted nunca sincronizava | `pull-request.closed` emitido no worker, listener na árvore da API → evento nunca cruzava processos em topologia split | #1494 — bridge PG LISTEN/NOTIFY (`cross-process-events.bridge.ts`) + claim de idempotência |
| Defaults Gemini mortos no sync | `GEMINI_2_5_FLASH/PRO` hardcoded — projeto GCP perdeu acesso ao Gemini (falha 100%) | `936f9ffc0` — GLM-4.7/Kimi + gate pós-trial-sem-BYOK (⚠️ novo silent-skip, sem teste) |

### 1.2 Reviews sem persistência no Mongo (9→11/jul, TODAS as reviews da janela)

- `pullRequest.heavy = heavy` em objeto **Immer-frozen** (`create-file-comments.stage.ts:545` pré-fix), introduzido pelo heavy mode #1504.
- Comentários postavam, Mongo vazio; TypeError engolido pelo catch do stage (`:217-233`).
- Mesma família bateu **2× na semana**: #1522 corrigiu `agent-review.stage` (`context.heavy` — ~27h com TODAS as reviews terminando "em segundos com 0 suggestions") e não viu a segunda instância; #1523 corrigiu esta.
- Fix: `c886e369a` — spread em vez de mutação + regression test com `Object.freeze`.

### 1.3 Finish-onboarding timeout (504)

- Sync de rules rodava **inline no request** com comentário desatualizado "fast, no LLM"; #1494 encareceu o sync (LLM) → nginx 60s → 504.
- Fix `2975273b1` (setImmediate) **introduziu segundo bug**: organizationId vinha do REQUEST scope, já disposto no background → `042978f4d` (param explícito). Ambos dentro do PR #1524.
- E2E **mascarava** o sintoma: `tests/e2e/lib/onboarding.ts:532` com `timeoutMs: 360_000` tratando 504 como "queued".

### 1.4 Models / BYOK / fallback

- `DEFAULT_MODEL` (byok-to-vercel.ts) apontava p/ Gemini sem acesso → conversation/geração de rules falhava 100%, em silêncio. Fix #1477 (→ kimi-k2.7-code).
- Fallback BYOK configurado **nunca era usado** no harness v5; erro de provider virava `finishReason: 'error'` → "0 suggestions" sem throw. Fix #1479 (`runWithProviderFallback`).
- Conversation hardcodava `temperature: 0` → modelos GLM rejeitavam, 0 tokens, sem resposta ("BYOK não conversa" do feedback). Fix `dc8b2559a` (25/jun) + mensagens de erro/plan-gate no #1477.

### 1.5 "Token drain de bilhões" — by-design, não leak

Fan-out real por review (deep + kody rules): 3 finders × 20-100 turns (cada turn reenvia a conversa), + rescue, + verifier por finding, + F+1 shards, + 3 passes secundários. GLM/Kimi coding tiers ~sem prompt caching → dezenas de milhões de input tokens/review.
Amplificadores de percepção na semana: #1515 moveu passes secundários da plataforma p/ a key BYOK; tokens do path shardado passaram a ser CONTADOS na analytics (antes invisíveis); fix de fallback re-roda o loop inteiro na key. Nenhum retry unbounded encontrado (fallback = retry-once; shard erro = degrade sem retry).

---

## 2. Por que os testes não pegaram — 4 padrões sistêmicos

1. **Catch-log-continue.** Frozen-object, wire-schema 400, fallback: tudo vira "review OK com 0 findings". Não há distinção entre "modelo não achou nada" e "todas as chamadas falharam"; nenhum alerta quando `shardsErrored === shardsRun`.
2. **Unit tests mockam exatamente a fronteira que quebrou.** Stage specs usam contexts não-congelados (freeze é comportamento do executor Immer, bypassed); LLM specs mockam `tracedGenerateText` (schema nunca serializado contra regras do provider); onboarding spec mockava o sync (latência invisível).
3. **Matriz asserta atividade, não outcome.** Assert de kody-rules tem fallback `suggestions>0 OU marker no comentário` → mascara o bug de persistência. `assertHealthyExecution` ligado em SÓ 1 cenário. Nenhum e2e asserta Mongo. Matriz roda só no modelo managed (leniente) — zero cobertura BYOK-OpenAI strict, o único provider que quebrava.
4. **Docs: verdade existe mas não publicada.** `rules_file_detection.mdx` in-repo correto (pós #1494); página publicada em kodustech/docs stale (77 linhas, sem AGENTS.md/`.cursor/rules`/limits) — o cliente leu o site. es/ja/zh não traduzidas.

---

## 3. Ainda ABERTO vs. feedbacks

- [ ] **#1488** — "1 sync error" sem detalhe (parcial: chip melhorado, issue aberta)
- [ ] **#1489** — limite de 10 rules: `MAX_KODY_RULES = 10` hardcoded (`kody-rules-validation.service.ts:24`), drop silencioso de rules ativas sem indicação na UI
- [ ] **Formatação mangled ao editar rule manualmente na UI** — nenhum commit tocou nisso (complaint 9, sem issue?)
- [ ] **#1490** — verificação user-visible "essa rule foi avaliada?" (hoje só logs `[kody-rules-eval]`)
- [ ] @-refs: depth 1 / máx 5 refs / não-resolvidos só logados
- [ ] CLAUDE.md/cursorrules ainda via LLM (verbatim só `.kody/rules/**`); gate pós-trial-sem-BYOK retorna `[]` silencioso — **sem teste**
- [ ] Higiene: `license-inactivity-policy.ts` nunca registrado em `scenarios/index.ts` (cenário morto); `conversation-anthropic-byok` fora do full.yml

---

## 4. Plano de testes priorizado

1. [ ] **Tirar o OR-fallback dos asserts de kody-rules** (`tests/e2e/scenarios/kody-rules.ts:296`, `kody-rules-file-sync.ts:266`): exigir `suggestionsCount > 0` persistido; marker só como diagnóstico. Uma linha — a matriz atual passaria a pegar o bug do Mongo.
2. [ ] **`assertHealthyExecution` em todo cenário que produz review** (command-review, command-review-focus, trial-managed-review, license-attribution, code-review-vertex-byok, upgrade). One-liners.
3. [ ] **Deep-freeze por default nos context builders dos stage specs** (ou slim integration test sob o executor Immer real) — família frozen-context bateu 2× na semana; pega instâncias futuras de graça.
4. [ ] **Schema-enumeration contract test** (`libs/llm/strict-wire-schema.spec.ts`): registry/glob que roda `assertStrictRequired` sobre TODOS os schemas que chegam em `runStructuredReviewCall` — hoje cobre só os 3 que falharam; novo call site com `.optional()` reintroduz o bug sem falhar CI.
5. [ ] **Assert de suggestions persistidas em code-review-basic**: após health, poll no endpoint de executions/suggestions e exigir ≥1 doc (fixture garante findings → 0 persistido = classe frozen-object).
6. [ ] **Cenário `finish-onboarding-slo`**: budget estrito (504 = FAIL, revertendo o mascaramento de `onboarding.ts:532`) + pós-condições: `kodyLearningStatus` ok E ≥1 rule gerada (path ONBOARDING_REPO_ANALYSIS não tem assert em lugar nenhum).
7. [ ] **Cobertura BYOK-OpenAI strict**: uma célula da matriz OU smoke que valida wire schemas contra o SDK real da OpenAI — único provider que quebrava, cobertura zero hoje.
8. [x] **Canário per-shard** — resolvido no MECANISMO, não como cenário e2e (que só roda no matrix cloud, não verificável localmente). A "shape exata" (um shard morto enquanto o outro posta) era silenciosa: falha parcial de shard só aparecia como `, N errored` numa linha info. O provider agora emite um **WARN estruturado** com `{shardsRun, shardsErrored, shardsSucceeded}` quando `0 < shardsErrored < shardsRun` — degrada (não falha, os survivors postam) mas fica alertável por-execution. Complementa item 10 (falha total → throw). Testes RED→GREEN em `kody-rules-agent.provider.spec.ts` (warn dispara no parcial c/ counts; caminho saudável fica quieto). 32/32 verdes.
9. [ ] **Liveness probe do modelo default managed** (classe "Gemini apodreceu em silêncio" — não pegável por routing test; probe periódico tipo `test-byok-model` contra o default da plataforma). + Unit do gate pós-trial-sem-BYOK (`936f9ffc0`, sem teste).
10. [ ] **Escalação quando `shardsErrored === shardsRun`** — hoje 100% de shard failure completa "com sucesso" (só warn logs); virar fail loudly/alerta.

## 5. Docs

- [ ] Publicar `docs/how_to_use/en/code_review/configs/rules_file_detection.mdx` (in-repo, correto) no kodustech/docs — **maior ROI customer-facing, é um sync**
- [ ] Traduzir es/ja/zh de `rules_file_detection.mdx` e `repository_rules.mdx` (PR #1494 flagou "need translation pass")
- [ ] Documentar `@kody-ignore` (implementado, undocumented)
- [ ] Check de release: SHA das páginas de config in-repo vs. publicadas (evitar drift de novo)

---

## Fora de escopo (produto/processo, não bugs de código)

Setup complexo, suporte só no Discord, migração conta→org travada (feedback do cliente que pausou).
