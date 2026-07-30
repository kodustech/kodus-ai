# Next.js 16 — registro da migração (`apps/web`)

Status: **migrado** no branch `feat/next-16` (de Next 15.5 → **16.2.10**,
React 19.2.7). Mantendo `next-auth` (Auth.js v5); a troca para **Better Auth**
é projeto separado e posterior.

## O que foi feito

- **Upgrade**: `npx @next/codemod@canary upgrade latest` → bump de `next`,
  `@next/third-parties`, `@next/bundle-analyzer` para 16.2.10 (+ minors de
  várias libs).
- **Gerenciador yarn → pnpm**: `apps/web` migrado para **pnpm** (projeto
  isolado via seu próprio `pnpm-workspace.yaml` — `nodeLinker: hoisted`,
  `overrides` portados dos `resolutions`, `allowBuilds: sharp`). `yarn.lock`
  removido, `pnpm-lock.yaml` gerado, `packageManager: pnpm@11.9.0`.
  Dockerfiles (`Dockerfile.web` + `.web.dev`) e `vercel.json` agora usam
  `corepack`/`pnpm`. (Fora de escopo: `apps/cli` segue em yarn.)
- **`middleware.ts` → `proxy.ts`**: `export const proxy = auth(...)` (shape
  oficial Auth.js p/ 16), matcher preservado. Runtime agora **nodejs** — os
  warnings de Edge Runtime (axios/jose via `core/config/auth.ts`)
  **desapareceram** (0 no build).
- **`next.config.js`**: `reactCompiler` movido para top-level;
  `turbopackFileSystemCacheForDev: true`; bloco `eslint` removido (não
  suportado no 16); `build-analyze` usa `next build --webpack`.
  `turbopackRustReactCompiler` **não** habilitado (é canary-only; no 16.2.x o
  React Compiler ainda roda via `babel-plugin-react-compiler` — migrar para a
  porta Rust quando chegar ao stable elimina o +13s de compile).
- **Build**: Turbopack por default no 16; `output: standalone` emite
  `.next/standalone/apps/web/server.js` corretamente. Build ~20s de compile
  (vs ~57–70s webpack no 15).
- **Parallel routes**: 21 `default.tsx` (pré-requisito do 16) — feito antes.
- **Limpeza**: removida a dep `@tanstack/react-query-next-experimental`
  (instalada e não usada). Ver `FRONTEND-DATA-PATTERNS.md`.

## Gates

- ✅ `check-types`: sem erros **novos** (só os pré-existentes: jest types,
  `User` do next-auth em `proxy.ts`, decorators/posthog em `libs/`).
- ✅ `next build` (Turbopack) verde + standalone emitido.
- ✅ smoke público `/sign-in` → HTTP 200, sem erro de runtime.
- ✅ SSO e2e **Quick** (imagem prod rebuildada **no 16**): 31 testes de
  cookie-domain + runtime smoke cloud/self-hosted.
- ⏳ SSO e2e **Full** (browser SAML round-trip + navegar cockpit) — pendente
  (exige rebuild da imagem da API). É o gate mais forte da mudança
  edge→nodejs do proxy; rodar antes de mergear.

## Guardas preservadas

- `src/app/layout.tsx`: `export const dynamic = "force-dynamic"` (Bug 1 SSO)
  intacto.
- Node: Docker `node:22.22.2-slim` / CI node 22 (≥ 20.9 ✅).

## Follow-ups

- Rodar o gate SSO **Full** antes do merge.
- **Better Auth** (next-auth → Better Auth): projeto separado; pendente
  exploração de escopo (só web-session vs auth inteira incl. `libs/ee/sso` +
  tabelas do `@better-auth/sso`).
- React Compiler → porta Rust (`turbopackRustReactCompiler`) quando sair do
  canary.
