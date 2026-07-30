# Plano - estabilizar o build e evoluir o monorepo do kodus-ai

> Revisado em 15/07/2026 contra o estado atual do repositorio.
>
> Para executar este plano: usar `superpowers:executing-plans` fase a fase, com
> checkpoint ao final de cada gate. Nao iniciar packageizacao, separacao EE ou
> migracao de bundler em paralelo sem que os respectivos pre-requisitos estejam
> verdes.

**Objetivo:** tornar build e CI previsiveis, introduzir orquestracao incremental
sem big-bang, reduzir o componente ciclico de 25 dominios e produzir uma
fronteira Community/Enterprise verificavel no codigo e nos artefatos.

**Arquitetura da mudanca:** quatro trilhas independentes, conectadas por gates:
confiabilidade do build, adocao incremental do Nx, modularizacao por contexto e
camada, e separacao Community/EE. Nx e Rspack sao ferramentas; nenhum deles e a
correcao para o acoplamento por si so.

**Stack:** Node.js 22, pnpm, NestJS, TypeScript, Webpack/SWC, Docker Buildx,
GitHub Actions e, apos aprovacao do spike, Nx.

---

## 1. Resumo executivo

### Decisoes mantidas

- Nao fazer big-bang.
- Medir antes de trocar ferramentas.
- Impor fronteiras no CI, com adocao ratchetada.
- Tratar a dependencia OSS -> EE como problema separado do acoplamento comum.
- Deixar Rspack e Nix para depois da estabilizacao do build.

### Decisoes corrigidas

- **Nx passa de "decisao fechada" para "candidato preferido, sujeito a spike".**
  O spike precisa provar descoberta correta dos projetos, affected confiavel,
  cache correto e integracao com os builds Nest atuais.
- **Projeto Nx nao significa package pnpm.** Primeiro registrar projetos com
  `project.json`; packageizar apenas onde houver valor concreto.
- **A Fase 0b de Docker/OOM vem antes do Nx.** O incidente de build nao deve
  esperar semanas de trabalho arquitetural.
- **Nao criar um unico `@kodus/contracts` global.** Preferir contratos publicos
  por contexto para evitar substituir `core` por outro god-module.
- **Community e Enterprise precisam de composition roots e artefatos distintos.**
  Gating runtime nao remove codigo EE de um bundle Community.
- **Rspack e condicional.** So migra app por app depois de um teste de paridade e
  ROI, preservando todos os comportamentos customizados do Webpack atual.

### Fora de escopo inicial

- Migrar `apps/web`, `apps/cli` e `apps/try` para o mesmo workspace raiz.
- Publicar os 28 dominios como pacotes npm.
- Trocar todos os aliases `@libs/*` de uma vez.
- Adotar Nix no build de producao.
- Reescrever a arquitetura Nest ou substituir RabbitMQ/outbox/inbox.

---

## 2. Estado atual revalidado

### Estrutura e workspace

- `apps/` possui 9 aplicacoes/pastas principais.
- `libs/` possui 28 dominios de primeiro nivel e nenhum `package.json`.
- `pnpm-workspace.yaml` contem configuracoes do pnpm, mas nao contem `packages:`.
- `pnpm list -r --depth -1` retorna apenas `kodus-orchestrator`.
- `apps/web`, `apps/cli`, `apps/mcp-manager` e `packages/kodus-common` mantem
  lockfiles proprios. Nao absorver esses projetos acidentalmente no workspace
  raiz durante o spike Nx.
- `nodeLinker: hoisted` esta habilitado para manter dependencias fantasmas do
  legado Yarn resolvendo. Package manifests "explicitos" ainda nao seriam uma
  fronteira real enquanto essa divida existir.

### Grafo de dependencias em 15/07/2026

Medicao por imports `@libs/*` em arquivos TypeScript:

- 28 dominios.
- 1.791 arquivos TypeScript em `libs/`.
- 5.041 ocorrencias de `@libs/*`.
- 924 arquivos importam outro dominio.
- 64 pares com ciclo direto A <-> B.
- **Um componente fortemente conectado (SCC) contem 25 dos 28 dominios.**

Os tres dominios fora do SCC principal sao `agent-harness`, `analytics` e
`cockpit`. Contagem de imports nao e KPI de arquitetura: ela pode crescer mesmo
quando as fronteiras melhoram. Os KPIs corretos sao tamanho dos SCCs, arestas
proibidas, numero de projetos sem ciclos e alcance de `affected`.

### O papel real de `core`

`core` continua sendo um hub, mas a hipotese "quase todos importam apenas tipos
de core" nao esta comprovada. Entre os caminhos importados por outros dominios,
ha forte presenca de:

- `core/infrastructure`: 762 ocorrencias;
- `core/domain`: 438;
- `core/log`: 399;
- `core/workflow`: 119.

Extrair contratos ajuda, mas nao basta. A maior alavanca inicial e retirar de
`core` a composicao de features e workflows que importam implementacoes de
`code-review`, `automation`, `platform`, `organization` e `ee`.

### Build e Docker

- Builder Webpack configurado globalmente em `nest-cli.json`.
- `build:apps` inicia seis `nest build` em background e usa `wait` sem propagar
  de forma confiavel o status de todos os filhos.
- O Webpack atual ja possui cache filesystem.
- O Docker persiste `node_modules/.cache` com BuildKit.
- Os workflows de release usam cache de camadas em registry/GHA.
- Portanto, o diagnostico correto e "sem task cache/affected", nao "sem cache".
- O workflow self-hosted executa o grupo default completo para `amd64` e
  `arm64`, com QEMU para a arquitetura nao nativa.
- O Dockerfile executa installs em `deps` e `prod-deps`, compila
  `packages/kodus-common` nas duas trilhas e executa seis builds Nest no estagio
  `build`.
- O projeto declara pnpm `11.9.0`, enquanto Docker de producao/Railway instala
  `10.34.1` e o Docker de desenvolvimento instala `11.7.0`.

### Fronteira EE

Medicao atual:

- 84 arquivos fora de `libs/ee` importam `@libs/ee/*`.
- 132 ocorrencias totais, incluindo testes.
- 74 arquivos quando specs sao excluidas.
- `libs/core/workflow/modules/workflow.module.ts` importa modulos EE diretamente.
- `apps/api/src/api.module.ts` tambem compoe `PermissionValidationModule` EE.

Esses numeros sao baseline tecnico, nao parecer juridico. A definicao do que
constitui uma distribuicao Community valida deve ser aprovada por produto e
juridico antes da mudanca de artefatos.

---

## 3. Metricas e gates

Cada fase so termina quando seu gate estiver documentado e reproduzivel.

| Area                        |                     Baseline | Gate minimo                                         |
| --------------------------- | ---------------------------: | --------------------------------------------------- |
| Corretude do build paralelo | Pode mascarar falha de filho | Qualquer app falhando faz `build:apps` falhar       |
| Versao pnpm                 |    11.9.0 / 11.7.0 / 10.34.1 | Uma versao em host, dev e producao                  |
| SCC principal               |                  25 dominios | Nao crescer; reducao por milestone documentada      |
| Ciclos diretos              |                           64 | Nao crescer; cada extracao reduz um conjunto medido |
| Imports OSS -> EE           |                  84 arquivos | Nao crescer; Community final = zero                 |
| Bundle Community com EE     |        Sem artefato separado | Zero fontes `ee/` ou `.ee.` no manifest/source map  |
| OOM multiarch               |          Limiar desconhecido | Build cabe no runner alvo com 20% de headroom       |
| Cache Nx                    |                  Inexistente | Hit local correto e estrategia de CI aprovada       |
| Affected                    |                  Inexistente | Mudanca em folha afeta apenas consumidores reais    |

Nao prometer percentuais genericos de reducao de CI. Registrar p50/p95 antes e
depois no proprio repositorio.

---

## 4. Sequencia geral

```text
Fase 0A - ferramentas reproduziveis
    -> Fase 0B - corretude e toolchain
    -> Fase 0C - diagnostico Docker/OOM
    -> Gate 0: build compreendido e estavel
    -> Fase 1 - spike Nx sem packageizacao
    -> Gate 1: adotar ou rejeitar Nx
    -> Fase 2 - todos os projetos + boundaries ratchetadas
    -> Fase 3 - separar Community/EE
    -> Fase 4 - quebrar SCC por contexto/camada
    -> Fase 5 - packageizacao/project references, se valer a pena
    -> Fase 6 - spike Rspack, condicional
    -> Fase 7 - Nix dev-shell, opcional
```

As Fases 0A-0C sao uma trilha operacional. As Fases 2-4 sao arquiteturais. Nao
usar uma para bloquear correcoes urgentes da outra.

---

## 5. Fase 0A - tornar diagnosticos reproduziveis

**Objetivo:** retirar evidencias de `/tmp` e transformar arquitetura/build em
fitness functions versionadas.

**Arquivos:**

- Criar: `scripts/architecture/dependency-graph.ts`
- Criar: `scripts/architecture/ee-boundary-audit.ts`
- Criar: `scripts/architecture/check-baseline.ts`
- Criar: `scripts/architecture/__fixtures__/`
- Criar: `docs-internal/architecture/baseline.json`
- Criar: `scripts/build/benchmark-docker-build.sh`
- Modificar: `package.json`
- Modificar: `.github/workflows/typecheck-gate.yml` ou criar workflow dedicado

### Passos

1. Implementar o grafo com TypeScript Compiler API, cobrindo imports estaticos,
   `import type`, dynamic import, `require` literal e aliases definidos no
   `tsconfig.json`.
2. Gerar arestas entre projetos, SCCs, ciclos diretos e lista de feedback edges.
3. Classificar imports OSS -> EE em runtime, type-only, teste e composition root.
4. Salvar snapshot deterministico em `baseline.json`.
5. Criar modo `--check` que falha apenas em regressao: SCC maior, novo ciclo ou
   novo import community -> enterprise.
6. Adicionar scripts:

```json
{
    "arch:graph": "ts-node scripts/architecture/dependency-graph.ts",
    "arch:ee": "ts-node scripts/architecture/ee-boundary-audit.ts",
    "arch:check": "ts-node scripts/architecture/check-baseline.ts"
}
```

7. Rodar fixtures do parser e depois `pnpm arch:check` no CI.

### Gate 0A

- Qualquer pessoa consegue reproduzir os numeros sem arquivos em `/tmp`.
- O snapshot e estavel entre duas execucoes sem mudanca de codigo.
- Um fixture com ciclo e um fixture com import EE fazem o check falhar.

---

## 6. Fase 0B - corrigir toolchain e build paralelo

**Objetivo:** eliminar drift barato e garantir que falhas nao sejam mascaradas.

**Arquivos:**

- Modificar: `package.json`
- Modificar: `docker/Dockerfile`
- Modificar: `docker/Dockerfile.dev`
- Modificar: `docker/Dockerfile.railway`
- Modificar: `scripts/dev/setup.sh`
- Criar: `scripts/build/run-app-builds.mjs`
- Criar: `scripts/build/run-app-builds.test.mjs`
- Testar: workflows de build backend e self-hosted

### Passos

1. Escolher `packageManager` do root como fonte de verdade.
2. Fixar a mesma versao exata de pnpm em todos os Dockerfiles e setup local.
3. Substituir `build:apps` por um runner Node baseado em `child_process.spawn`
   que preserve concorrencia, encaminhe stdout/stderr, encerre os processos
   restantes quando um falhar e retorne exit code diferente de zero. Nao usar
   `concurrently`: ele nao esta instalado no workspace atual.

```json
{
    "build:apps": "node scripts/build/run-app-builds.mjs"
}
```

4. Fazer o runner aceitar uma lista de comandos injetavel apenas para testes.
   Cobrir: todos passam, um falha, processo recebe sinal e output continua
   identificavel por app.
5. Separar lint mutante de lint de CI:

```json
{
    "lint": "pnpm lint:check",
    "lint:check": "eslint \"{apps,libs,core,shared,test}/**/*.ts\" --cache",
    "lint:fix": "pnpm lint:check --fix"
}
```

6. Rodar `pnpm build:apps`, `pnpm build:migrations`, `pnpm typecheck` e os testes
   de maior risco.

### Gate 0B

- Versao pnpm unica.
- Um build filho falhando derruba o comando agregado.
- Build completo continua produzindo os mesmos entrypoints em `dist/apps/*`.
- CI nao modifica arquivos durante lint.

---

## 7. Fase 0C - diagnosticar e estabilizar Docker/OOM

**Objetivo:** identificar se o pico vem de install, build Nest, QEMU, BuildKit ou
sobreposicao entre estagios/plataformas.

**Arquivos:**

- Modificar: `scripts/build/benchmark-docker-build.sh`
- Possivelmente modificar: `docker/Dockerfile`
- Possivelmente modificar: `docker-bake.hcl`
- Possivelmente modificar: `.github/workflows/selfhosted-build-push.yml`
- Criar: `docs-internal/architecture/docker-build-baseline.md`

### Matriz obrigatoria

Executar frio e quente, registrando wall time, CPU, RSS/cgroup peak e cache hit:

1. `deps` isolado em `linux/amd64`.
2. `build` isolado em `linux/amd64`.
3. Um target backend em `linux/amd64`.
4. Grupo default em `linux/amd64`.
5. Um target backend em `linux/arm64` via QEMU.
6. Grupo default em `linux/arm64`.
7. Grupo default multiarch, igual ao workflow real.

Comandos-base:

```bash
docker buildx build --progress=plain --target deps -f docker/Dockerfile .
docker buildx build --progress=plain --target build -f docker/Dockerfile .
docker buildx bake -f docker-bake.hcl --progress=plain --set '*.platform=linux/amd64' api
docker buildx bake -f docker-bake.hcl --progress=plain --set '*.platform=linux/amd64' default
docker buildx bake -f docker-bake.hcl --progress=plain --set '*.platform=linux/arm64' default
```

O script deve validar o nome correto do grupo/targets suportado pelo Bake antes
de automatizar a matriz.

### Otimizacoes a testar, uma por vez

1. Copiar o `dist` ja gerado de `kodus-common` para `prod-deps`, evitando
   recompilar o pacote pela segunda vez.
2. Comparar `pnpm fetch` + install offline com o fluxo atual.
3. Limitar paralelismo do BuildKit antes de reduzir paralelismo dos seis apps.
4. Dividir `amd64` e `arm64` em jobs separados e criar o manifest depois.
5. Separar web do bake backend se ele competir por memoria sem compartilhar
   camadas relevantes.
6. Avaliar se `analytics-cli` e `ast-cli` precisam estar em todo artefato ou se
   podem ser um target de ferramentas separado.

Cada experimento gera uma linha comparavel no baseline. Nao combinar mudancas
antes de saber qual removeu o gargalo.

### Gate 0C

- Causa do OOM reproduzida ou descartada por estagio/plataforma.
- Build completo cabe no runner suportado com 20% de headroom.
- Build frio e quente possuem baseline versionada.
- Nenhuma otimizacao depende de cache local que nao exista no CI.

---

## 8. Fase 1 - spike Nx sem packageizacao

**Objetivo:** validar Nx com baixo blast radius, mantendo pnpm, Nest CLI,
Webpack, aliases e layout atuais.

**Decisao importante:** nao adicionar `packages:` amplo ao
`pnpm-workspace.yaml` nesta fase. O repositorio possui subprojetos com lockfiles
e ciclos de instalacao independentes.

**Arquivos:**

- Criar: `nx.json`
- Criar: `apps/api/project.json`
- Criar: `apps/worker/project.json`
- Criar: `apps/webhooks/project.json`
- Criar: `apps/mcp-manager/project.json`
- Criar: `apps/analytics-cli/project.json`
- Criar: `apps/ast-cli/project.json`
- Criar inicialmente: `libs/agent-harness/project.json`
- Criar inicialmente: `libs/core/project.json`
- Criar inicialmente: `libs/code-review/project.json`
- Modificar: `package.json`
- Modificar: `.gitignore`

### Passos

1. Executar `nx init` em branch/worktree isolada e revisar todo o diff; nao
   assumir que apenas `nx.json` sera criado.
2. Reverter no proprio spike qualquer reescrita automatica de scripts que mude
   comportamento sem necessidade.
3. Registrar os seis builds backend como targets separados, inicialmente via
   `nx:run-commands` chamando os scripts atuais.
4. Declarar outputs exatos, por exemplo `dist/apps/api`, e inputs compartilhados:
   `nest-cli.json`, `webpack.config.js`, `tsconfig*.json`, lockfile e configs de
   ambiente geradas.
5. Incluir `API_CLOUD_MODE`, `NODE_ENV` e demais variaveis que alteram bundle no
   hash da task.
6. Rodar:

```bash
pnpm nx show projects
pnpm nx graph
pnpm nx run-many -t build --projects=api,worker,webhooks,mcp-manager,analytics-cli,ast-cli
pnpm nx build api
pnpm nx build api
```

7. Confirmar no segundo build que o output foi restaurado corretamente do cache.
8. Alterar um fixture em `agent-harness` e conferir o affected esperado.
9. Alterar um arquivo exclusivo de `apps/webhooks` e conferir que API/worker nao
   entram no affected sem dependencia real.
10. Nao habilitar remote cache ate definir seguranca, retencao, custo e quem
    possui permissao de escrita.

### Gate 1 - decisao Nx

Adotar Nx somente se:

- Os projetos esperados aparecem no graph.
- As arestas principais batem com `arch:graph`.
- Cache restaura os artefatos corretos sem output compartilhado corrompido.
- `affected` nao omite consumidores conhecidos.
- O fluxo Docker/CI continua funcionando sem depender de estado local.
- A equipe aceita o modelo de configuracao e atualizacao do Nx.

Se o gate falhar, manter os scripts de arquitetura e avaliar uma combinacao mais
simples de `dependency-cruiser`/ESLint + runner concorrente. Fronteiras nao
dependem obrigatoriamente de Nx.

---

## 9. Fase 2 - registrar todos os projetos e impor boundaries

**Objetivo:** dar identidade de projeto aos 28 dominios sem packageiza-los e
impedir novas dividas antes de corrigir as antigas.

**Arquivos:**

- Criar: `libs/*/project.json`
- Modificar: `eslint.config.js`
- Modificar: `nx.json`
- Modificar: `docs-internal/architecture/baseline.json`
- Modificar: workflows de lint/typecheck

### Tags iniciais

Cada projeto recebe primeiro apenas tags que representam fatos atuais:

- `scope:<contexto>`
- `edition:community` ou `edition:enterprise`
- `layer:mixed` para dominios ainda nao separados

Nao marcar a pasta inteira `libs/code-review` como `type:domain` ou
`type:feature`: ela contem domain, application, infrastructure, pipeline e
composition modules ao mesmo tempo.

### Enforcement ratchetado

1. `arch:check` bloqueia qualquer nova violacao desde o primeiro PR.
2. `@nx/enforce-module-boundaries` entra como `error` apenas para projetos e
   constraints que ja estejam limpos.
3. Projetos community nao podem depender de `edition:enterprise`; para
   dependencias internas usar tags/`notDependOnLibsWithTags`, nao
   `bannedExternalImports`.
4. Criar matriz explicita de dependencias permitidas entre scopes. Nao assumir
   que todo contexto depende apenas de si e de `shared` sem validar os fluxos de
   negocio existentes.
5. Deep imports so podem atravessar projeto por entrypoint publico. Esse gate
   entra depois que cada projeto possuir barrel/API estavel.

### Cache e CI

- Cache local: habilitar apenas para tasks deterministicas.
- CI efemero: decidir entre Nx Cloud, servidor remoto autenticado ou persistir
  `.nx/cache` via BuildKit/Actions.
- Definir `inputs` e `outputs` antes de marcar qualquer task como cacheable.
- Restringir escrita no cache remoto ao CI confiavel para evitar cache poisoning.

### Gate 2

- 28 dominios e 6 apps backend aparecem no grafo.
- Nenhuma nova aresta proibida entra no baseline.
- Toda task cacheada possui inputs/outputs auditados.
- Existe dashboard ou relatorio simples de SCC, cycles e affected por PR.

---

## 10. Fase 3 - separar Community e Enterprise

**Objetivo:** garantir por compilacao e teste que Community nao depende nem
empacota codigo `ee/` ou `.ee.`.

### Gate de produto/juridico antes do codigo

Documentar e aprovar:

- Quais features pertencem a Community, Teams e Enterprise.
- Se self-hosted sem licenca EE deve permitir, negar ou degradar cada capacidade.
- Quais artefatos podem conter codigo EE.
- Se `cockpit` deve ser relocado integralmente para EE.
- Compatibilidade esperada para instalacoes self-hosted existentes.

### Arquitetura correta

Regra de dependencia:

```text
community contracts/core <- community implementation
community contracts/core <- enterprise adapters
community app             <- community implementation
enterprise app            <- community core + enterprise adapters
```

Nunca:

```text
core/community -> require/import enterprise
```

Feature gate runtime controla comportamento de uma edicao que ja contem a
feature. Ele nao e mecanismo para excluir codigo de um artefato Community.

### Composition roots

Criar entrypoints/modulos distintos, por exemplo:

- `apps/api/src/main.community.ts`
- `apps/api/src/main.enterprise.ee.ts`
- equivalentes para worker e webhooks quando necessario
- targets Nx/Nest separados: `api-community` e `api-enterprise`

O entrypoint Community importa apenas modulos Community. O entrypoint Enterprise
faz o wiring de adapters EE nos tokens definidos do lado Community.

### Contratos e portas

- Contratos pertencem ao contexto consumidor, nao a um pacote global generico.
- Exemplo de layout alvo apos split:

```text
libs/organization/contracts
libs/organization/domain
libs/organization/data-access
libs/organization/feature
libs/licensing/contracts
libs/ee/license
```

- Usar `import type` para tipos puros.
- Reconhecer que DI tokens, enums e classes de erro sao runtime. Se ficarem no
  projeto de contracts, o projeto e "baixo runtime", nao "zero runtime".
- Um contrato de licensing nao deve importar `OrganizationAndTeamData` de
  `core`; mover o DTO minimo para o contrato dono ou reduzir a assinatura.
- Evitar uma porta monolitica que misture licenca, BYOK, trial credits e resource
  limits. Primeiro caracterizar comportamento; depois separar capacidades.

### Ordem de migracao EE

1. Escrever characterization tests do comportamento atual em cloud,
   development, self-hosted licenciado e self-hosted sem licenca.
2. Remover imports `core -> ee`, comecando por `WorkflowModule` e entidades SSO.
3. Criar composition roots separados nos apps.
4. Extrair porta de permission/licensing com default Community aprovado por
   produto; nao assumir "allow everything" sem tabela de decisao.
5. Migrar consumidores para token, um modulo por vez.
6. Migrar audit log e SSO.
7. Criar extension points para code-review pipeline e Kody Rules.
8. Relocar `cockpit` somente apos decisao de tier.
9. Ativar constraint `edition:community` -> nao depende de
   `edition:enterprise` como erro.

### Verificacao de artefato

**Arquivos:**

- Criar: `tsconfig.community.json`
- Criar: `scripts/architecture/check-community-bundle.ts`
- Criar: testes de smoke Community
- Modificar: Docker/bake para targets Community e Enterprise

O check deve analisar manifest/stats/source maps do bundler e falhar se qualquer
source apontar para `/libs/ee/` ou arquivo `.ee.`. Apenas procurar strings no JS
final nao e suficiente.

### Gate 3

- `pnpm build:community` compila com `libs/ee` indisponivel.
- API, worker, webhooks e migrations Community iniciam em smoke test.
- Nenhum source EE aparece nos artefatos Community.
- Enterprise preserva comportamento via contract/characterization tests.
- Imports community -> EE chegam a zero.

---

## 11. Fase 4 - quebrar o SCC por contexto e camada

**Objetivo:** reduzir gradualmente o SCC de 25 dominios e tornar as regras de
camada verdadeiras no filesystem.

### Ordem revisada

1. **Retirar composicao de `core`.** Mover workflow/composition para app ou
   projeto dedicado. Isso corta arestas runtime de alto impacto.
2. **`agent-harness`.** Projeto ja sem dependencias internas e com consumidores
   claros; usar como primeiro projeto limpo.
3. **Contratos por contexto.** Extrair somente contratos que removem arestas
   comprovadas pelo feedback-edge report.
4. **Near-leaves.** `sandbox`, `llm`, `telemetry`, `notifications` apos
   revalidacao do grafo.
5. **Contextos centrais.** `organization`, `identity`, `platform` e
   `code-review`, um por vez.
6. **Top-level features.** `analytics`/`cockpit` depois da decisao de produto e
   edicao.

### Layout alvo por contexto

```text
libs/<scope>/contracts     # API publica, tipos e tokens minimos
libs/<scope>/domain        # entidades e regras puras
libs/<scope>/data-access   # DB, HTTP e clients externos
libs/<scope>/feature       # use-cases e orquestracao do contexto
libs/<scope>/composition   # modulos Nest; idealmente consumidos pelos apps
```

Nem todo contexto precisa de todas as pastas. Criar apenas quando houver codigo
real para separar.

### Regras de camada

| Origem             | Pode depender de                              |
| ------------------ | --------------------------------------------- |
| `type:contracts`   | contracts publicos necessarios                |
| `type:domain`      | contracts, domain do mesmo scope, utils puros |
| `type:data-access` | contracts, domain e utils                     |
| `type:feature`     | contracts, domain, data-access e utils        |
| `type:composition` | feature e adapters necessarios                |
| `type:app`         | composition/features da edicao correspondente |

Dependencia cross-context deve ir para API publica do contexto alvo. Criar uma
matriz explicita de scopes permitidos; `scope:shared` nao pode virar escape hatch.

### Metodo por extracao

Para cada extracao:

1. Registrar SCC/ciclos antes.
2. Escrever ou mover testes de comportamento.
3. Criar novo projeto e API publica.
4. Migrar um consumidor.
5. Rodar build/typecheck/test/arch:check.
6. Migrar demais consumidores.
7. Ativar boundary como erro.
8. Registrar SCC/ciclos depois.
9. Commit pequeno e reversivel.

### Gate 4

- O SCC principal reduz de tamanho a cada milestone acordada.
- Nenhum projeto marcado com camada mistura infraestrutura e domain.
- Novos contextos entram sem depender de `core` por conveniencia.
- Deep imports cross-project estao bloqueados onde APIs publicas ja existem.

---

## 12. Fase 5 - packageizacao e TypeScript project references

**Objetivo:** avaliar package boundaries reais somente depois que o grafo for um
DAG suficientemente limpo.

Nx nao exige `package.json` por lib. Packageizar apenas quando houver necessidade
de pelo menos um destes itens:

- dependencia externa explicita por projeto;
- output buildavel independente;
- publicacao/versionamento;
- `pnpm deploy`/pruning por aplicacao;
- TypeScript project references com ganho medido.

### Cuidados

- Nao adicionar `apps/*` indiscriminadamente ao `pnpm-workspace.yaml`.
- Preservar workspaces/lockfiles independentes de web, CLI e try ate haver plano
  especifico para unificacao.
- Usar `workspace:*` para dependencias internas.
- Centralizar versoes Nest/TypeScript para evitar multiplas copias de singletons.
- Migrar dependencias fantasmas antes de remover `nodeLinker: hoisted`.
- Ciclos pnpm entre packages indicam que a packageizacao ocorreu cedo demais.

### Gate 5

- Nenhum ciclo entre workspace packages.
- `pnpm install --frozen-lockfile` funciona no host e Docker.
- O pruning de runtime reduz tempo/tamanho de imagem de forma medida.
- Project references melhoram typecheck incremental sem quebrar aliases/Jest.

---

## 13. Fase 6 - spike Rspack, condicional

**Objetivo:** decidir por evidencia se Rspack reduz tempo ou memoria depois das
otimizacoes de Docker, Nx e Webpack cache.

### Primeiro app

Comecar por `webhooks` ou `mcp-manager`, nao por API/worker. Escolher o menor app
que ainda exercite decorators Nest, aliases e assets.

### Paridade obrigatoria

O spike deve preservar:

- SWC com decorators e `decoratorMetadata`;
- plugin/metadata Swagger do Nest;
- `CopyDictionariesPlugin`;
- `CopySkillsPlugin` ou assets equivalentes;
- HMR/watch e execucao automatica em desenvolvimento;
- source maps e upload Sentry;
- `webpack-node-externals`/externalizacao equivalente;
- aliases do `tsconfig`;
- output paths esperados pelos Dockerfiles;
- startup, migrations e resolucao de dependencias em runtime.

### Benchmark

Comparar Webpack e Rspack em:

- cold build;
- warm build sem mudanca;
- rebuild apos mudar uma folha;
- rebuild apos mudar `core`;
- peak RSS no container;
- tamanho do bundle;
- tempo de startup;
- manutencao/configuracao adicional.

### Gate 6

Migrar os demais apps somente se:

- toda a matriz de paridade passar;
- houver ganho material previamente acordado;
- o ganho continuar existindo dentro do Docker/CI real;
- a equipe aceitar a dependencia e a estrategia de upgrade Nx/Rspack.

Caso contrario, manter Webpack com cache atual. "Nao migrar" e resultado valido
do spike.

---

## 14. Fase 7 - Nix dev-shell, opcional

Considerar apenas se ainda houver drift local relevante depois de:

- Node e pnpm pinados;
- base images por digest;
- lockfiles consistentes;
- devcontainer/setup reproduzivel;
- builds Docker medidos.

Se necessario, iniciar apenas com `nix develop`. Nix nao entra no build de
producao nesta iniciativa.

---

## 15. Backlog operacional separado

Esses itens nao sao pre-requisitos tecnicos para Nx ou modularizacao. Manter em
track separado para nao misturar ownership e prazo:

- PR #1538 - TOCTOU sandbox, review e merge.
- PR #1471 - sandbox cleanup, rebase/conflito e nova revisao.
- Ja concluidos no contexto original: #1469, #1473 e #1513.

Revalidar o estado dos PRs antes da execucao; os numeros foram capturados no
plano original e podem estar desatualizados.

---

## 16. Checklist de readiness por PR

Todo PR desta iniciativa deve declarar:

- Fase e gate afetados.
- Baseline antes/depois.
- Projetos/artefatos impactados.
- Comandos de verificacao executados.
- Estrategia de rollback.
- Mudanca de cache/input/output, se houver.
- Impacto Community/Enterprise, quando aplicavel.
- Confirmacao de que nao aumentou SCC, ciclos ou imports OSS -> EE.

Comandos minimos, ajustados ao escopo:

```bash
pnpm arch:check
pnpm typecheck
pnpm test
pnpm build:apps
pnpm build:migrations
```

Depois da adocao do Nx:

```bash
pnpm nx affected -t lint,typecheck,test,build
```

Nao rodar a suite inteira por ritual quando o grafo e o risco justificarem um
subset, mas registrar claramente o que nao foi executado.

---

## 17. Fontes tecnicas

- [Nx - Adding to an existing monorepo](https://nx.dev/docs/guides/adopting-nx/adding-to-monorepo)
- [Nx - pnpm workspaces](https://nx.dev/docs/guides/tips-n-tricks/pnpm-workspaces)
- [Nx - project configuration](https://nx.dev/docs/reference/project-configuration)
- [Nx - enforce module boundaries](https://nx.dev/docs/guides/enforce-module-boundaries)
- [Nx - remote caching](https://nx.dev/docs/features/ci-features/remote-cache)
- [Nx - Rspack executors](https://nx.dev/docs/technologies/build-tools/rspack/executors)
- [Nx - NestJS](https://nx.dev/docs/technologies/node/nest/introduction)
- [Webpack - tree shaking](https://webpack.js.org/guides/tree-shaking/)

---

## 18. Proxima decisao

Iniciar pela Fase 0A. Ela transforma este plano em um sistema verificavel: sem
scripts e baselines versionados, os numeros voltam a ficar desatualizados e as
demais fases perdem o gate de seguranca.
