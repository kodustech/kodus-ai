# Kody Rules — resumo estruturado de rules longas (produtização)

## Contexto

Investigação Physitrack (2026-07): recall de kody rules limitado pela **detecção do judge**,
não pelos filtros (fase1==fase2 medido). Experimento validado no eval
(`evals/kody-rules/summarize-rules.js` + `rails-convention-cases-summarized.json`):
rules >1000 chars pré-processadas em **"WHAT TO VALIDATE / HOW TO VALIDATE"**
(inglês, 2 seções, exemplos mantidos deterministicamente) no lugar do texto integral.

Resultados (PR #6478 análogo, 3 reps, occurrence recall):
- gpt-5.4-mini: 32% → **59% média** (+27pp), file-recall 53→82%
- kimi-k2.7-code: 84% → média 81 (pico **95%**) — sem regressão
- glm-5.2 (modelo do cliente): estável ~74%, file-recall até 95%

Variantes testadas e **rejeitadas** (não repetir): exemplos antes da descrição
(GLM 79→47%); checklist de vereditos (gpt flat); 3ª seção "WHEN NOT TO FLAG"
(gpt 59→53, kimi 81→63 — conservadorismo).

## Decisões de design

1. **Campo novo** no item da rule: `summary { content, sourceHash, generatedAt, model }`.
   Consumido **exclusivamente** pelo path de review — UI/sync/export usam sempre `rule` integral.
2. **Rule longa** = `rule.length > 1000` chars.
3. **Hash como salva-guarda**: `sourceHash = sha256(rule)`. Na review: summary só é usado
   se hash bater; mismatch → usa original + **log estruturado**. Isso torna hooks de escrita
   otimização, não requisito de correção (rules são escritas por 7+ call sites).
4. **Geração**: prompt verbatim do experimento (2 seções), `generateText` simples, async.
   - No write (create/update/import): hook fire-and-forget no choke point
     `libs/ee/kodyRules/service/kodyRules.service.ts` (todos os caminhos convergem ali).
     Update que encurta a rule (≤1000) limpa `summary`.
   - Lazy backfill na review (cobre legado, ex.: 27 rules Physitrack): rule longa sem
     summary válido → gera + persiste + usa na própria execução. Concorrência limitada (3).
     Falha de geração → usa texto integral, review nunca bloqueia.
5. **Política de modelo** (mesma da review): BYOK main → sem BYOK+trial: managed →
   trial acabado sem BYOK: **não gera** (usa texto integral).

## Arquivos

| # | Arquivo | Mudança |
|---|---|---|
| 1 | `libs/kodyRules/domain/interfaces/kodyRules.interface.ts` | `IKodyRuleSummary` + campo `summary?` em `IKodyRule` |
| 2 | `libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model.ts` | campo no schema Mongoose |
| 3 | `libs/kodyRules/.../services/kody-rule-summary.service.ts` (novo) | `isLong`, `generate`, `resolveForReview`, `ensureSummaries` |
| 4 | `libs/ee/kodyRules/service/kodyRules.service.ts` | hook async pós-write + limpeza quando encurta |
| 5 | `libs/code-review/pipeline/stages/agent-review.stage.ts` | `ensureSummaries` (lazy) + `resolveForReview` antes do `buildOrchestratorInput` |
| 6 | specs | service unit (threshold/hash/política) + stage spec (swap) |

## Validação

- Unit specs acima.
- Regressão: matriz do eval análogo (`run-full-pipeline.js`) — números devem bater com o v1.
- Pós-deploy: log de hash-mismatch monitorável; primeira review da Physitrack popula os summaries.
