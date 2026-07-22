# Plano — Sync de Kody Rules globais a partir de repositórios selecionados

## Objetivo
Permitir que o usuário selecione um ou mais repositórios conectados como **fontes de
Kody Rules globais**. As rules desses repos são importadas com o **mesmo mecanismo de
scan e manutenção** que já existe hoje para rules por-repositório, mas salvas no
**escopo global** (`repositoryId = "global"`).

Sem marcador `@kody-global` — a seleção do repo-fonte é o único gatilho.

## Como o sistema funciona hoje (baseline confirmado)
- Scan por padrões de path hardcoded em `libs/common/utils/kody-rules/file-patterns.ts`
  (`RULE_FILE_PATTERNS`): `.cursorrules`, `.cursor/rules/**`, `CLAUDE.md`, `AGENTS.md`,
  `.github/copilot-instructions.md`, `.kody/rules/**`, `rules/**/*.md`, etc.
- Orquestração: `libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service.ts`
  - `syncRepositoryMain` (scan de árvore completa, `getRepositoryAllFiles`)
  - `syncFromChangedFiles` (incremental, changed files de um PR)
- Escopo/"nível" é modelado por campos, não por enum: `repositoryId` (sentinel
  `"global"` para org-wide) + `directoryId`. `KodyRulesScope` só tem `FILE`/`PULL_REQUEST`.
- Gate atual `ideRulesSyncEnabled` é **por repo** (dentro de `CODE_REVIEW_CONFIG`).
- Update por-repo hoje: listener `pull-request.closed` → `syncFromChangedFiles`.
- **Scan não exige webhook** — só integração de code management ativa + nome do repo.
  Webhook importa só para **updates** (em modo token, só repos selecionados têm webhook).

## Decisões travadas
1. **Picker restrito aos repos já selecionados em git settings** (`useGetSelectedRepositories`).
   Garante updates uniformes entre GitHub App e token/self-hosted.
2. **Overlap repo×global: independentes.** Se um repo é fonte global E tem
   `ideRulesSyncEnabled`, aceita-se a possível duplicação de contexto (dedup fica pra depois).
3. **Deselect = soft-delete** das rules globais originadas daquele repo.
4. Sem `@kody-global`.

## Mudança de schema (crítica)
Rule global hoje só sabe `repositoryId="global"` — perde a origem. Adicionar:
- **`sourceRepositoryId`** na rule sincronizada (e no `CreateKodyRuleDto`).
- Chave de upsert do global passa a ser **`("global", sourceRepositoryId, sourcePath)`**
  — evita colisão entre repos com mesmo arquivo (ex. dois `CLAUDE.md`).

Necessário para: (a) cleanup no deselect, (b) rotear updates no PR merge,
(c) status por repo na tabela da UI.

## Persistência da lista de fontes globais
Novo org-parameter (ex. `GLOBAL_RULES_SOURCE_REPOSITORIES`) guardando os repos-fonte
selecionados. Fonte da verdade para o cálculo de delta.

## Fluxo de save (delta, sem re-importar o que já existe)
No confirmar da seleção, comparar lista nova vs. anterior:
- **Adicionados:** scan completo (`syncRepositoryMain`-equivalente) gravando em
  `repositoryId="global"` + `sourceRepositoryId=<repo>`.
- **Removidos:** soft-delete das rules globais com aquele `sourceRepositoryId`.
- **Inalterados:** pular (o sync já é idempotente via upsert, mas evitamos re-scan à toa).

## Rotina de atualização
Problema: repos-fonte podem ser só-de-regras e quase nunca ter PR. Além disso **não
recebemos evento de push** (só `pull_request.closed`) — mudança via push direto na main
não dispara nada hoje.

Solução (cron + short-circuit por SHA, ambos baratos):
- **Cron diário em background** (via `@nestjs/schedule` — já usado; ex. cron de kody-rules
  às 04:00 em `kody-rule-detector-sweep.service.ts`) varrendo todos os repos-fonte globais.
  Primário: pega push direto, previsível, decoupled de PR.
- **Short-circuit por SHA:** `getRepositoryAllFiles` já retorna o SHA de cada arquivo do
  git tree. Persistir o SHA por arquivo sincronizado (reaproveitar o campo dormente
  `lastContentHash` em `kodyRules.interface.ts:200`, hoje declarado e nunca usado) e no
  re-scan só reconverter arquivo novo/alterado/removido. Re-scan sem mudança = 1 chamada
  de git tree por repo, sem download, sem LLM.
- **PR merged no próprio repo-fonte** → mantém como caminho imediato (estender o listener
  `kody-rules-sync.listener.ts` para fan-out ao escopo global).
- **Botão manual "resync global"** espelhando `/resync-ide-rules`.

Descartado: usar "qualquer PR da org" como gatilho — proxy ruim (spam em org ativa,
silêncio em org quieta, que é justo o caso do repo só-de-regras).

## Backend — arquivos a tocar
- `kodyRulesSync.service.ts`: variante das rotinas de scan aceitando target global +
  `sourceRepositoryId`; lógica de upsert com nova chave.
- `libs/ee/kodyRules/dtos/create-kody-rule.dto.ts`: campo `sourceRepositoryId`.
- `libs/kodyRules/domain/interfaces/kodyRules.interface.ts`: interface da rule.
- Mongo model em `libs/core/infrastructure/database/mongo/kody-rules/`.
- `kody-rules-sync.listener.ts`: fan-out para escopo global no `pull-request.closed`.
- Novos use-cases: `sync-global-source-repositories`, `resync-global-rules`,
  `get-global-source-repositories`, `update-global-source-repositories` (delta + cleanup).
- Novo org-parameter key + leitura/escrita.
- Controller `apps/api/src/controllers/kodyRules.controller.ts`: endpoints de
  get/save fontes globais + resync global.

## Frontend — arquivos a tocar
- Aba Configuration da tela de Kody Rules (escopo global):
  `apps/web/.../kody-rules/_components/_page.tsx` (TabsContent configuration,
  gate `isGlobalView`).
- Reusar `core/components/system/select-repositories.tsx` (`SelectRepositories`) para
  o multi-select — alimentado por repos **selecionados** (`useGetSelectedRepositories`).
- Novo componente: controle de ativação + tabela de repos-fonte já selecionados
  (abrir picker de novo, remover repo).
- Client + hooks em `apps/web/src/lib/services/kodyRules/` (fetch.ts, hooks.ts, index.ts)
  para os novos endpoints.

## Skip de code review em repo-fonte
Repo selecionado só como fonte de Kody Rules globais é repo de config/dados, não
codebase. Espelha o comportamento do centralized config: em
`validate-prerequisites.stage.ts`, se o repo do PR está na lista
`GLOBAL_RULES_SOURCE_REPOSITORIES`, o review é marcado `SKIPPED` (não roda automação).
Checagem independente da do centralized config; se um repo é os dois, o centralized
skipa primeiro. Push direto fica fora (só PR-merge dispara, por decisão de escopo).

## Pontos em aberto / follow-ups (fora do MVP)
- **Cron diário de resync** (mecanismo primário no plano original; adiado). Só GitHub/
  Forgejo recebem webhook de push hoje — Azure/Bitbucket/GitLab exigiriam mudar a
  subscription + re-registrar hooks, então push-como-evento foi descartado por ora.
- Dedup de contexto quando há overlap repo×global.
- Status de sync por repo-fonte na tabela (usar `sourceRepositoryId`).
- Feedback de progresso durante o scan inicial (pode ser demorado para muitos repos).
