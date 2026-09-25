# instructions-setup.md

> **Para que serve este arquivo.** Ele descreve tudo que precisa existir **na
> máquina** antes de qualquer rodada de eval do code review agêntico: clones dos
> repositórios do benchmark, credenciais, ferramentas e — se o teste envolver
> grafo — a geração do call graph pelo `kodus-graph`.
>
> É o documento de **preparação de ambiente**. Ele não explica como rodar o
> eval nem como interpretar resultado: isso é o `instructions-eval.md`.
>
> Se você é um agente executando isto: faça as seções na ordem e rode a
> verificação final (§7). Ela falha alto se faltar alguma coisa; não pule.

---

## 1. Ferramentas

| ferramenta | versão | por quê |
|---|---|---|
| Node | **24.x** | o harness roda em `node` com `ts-node/register/transpile-only` |
| pnpm | **11.9.0** | `packageManager` do repo |
| git | qualquer recente | o harness cria **worktrees** por PR |
| Python | 3.9+ | `relatorio.py` e os scripts de análise |
| **bun** | 1.x | **só se for usar grafo** — o CLI do `kodus-graph` roda em bun |

```bash
node -v          # tem que dar v24.x
pnpm -v          # 11.9.0
python3 -V
```

Instale as dependências do repo a partir da **raiz**:

```bash
cd <raiz-do-kodus-ai>
pnpm install
```

> **Sempre rode os scripts a partir da raiz do repositório** (ou pelos wrappers
> em `evals/investigation/`, que já fazem `cd`). Os caminhos do
> `tsconfig-paths` são resolvidos a partir da raiz; rodar de dentro de
> `evals/investigation` quebra os imports de `libs/`.

---

## 2. Clones dos repositórios do benchmark

O eval **não** usa fixtures gravadas: cada PR é revisado contra o **código real**,
num worktree do commit `head` daquele PR. Sem os clones, o harness cai em
replay e as ferramentas do agente (`grep`, `readFile`, `listDir`) devolvem nada
— o recall despenca e não é culpa do modelo.

### Onde eles ficam

Diretório raiz, definido em `prepare-repo.js`:

```
BENCH_REPOS_ROOT   (variável de ambiente)
default: ~/projects/benchmark
```

### Quais clonar

Cinco repositórios, com **estes nomes de pasta exatos** (o mapeamento
`REPO_DIRS` em `prepare-repo.js` depende deles):

```bash
export BENCH_REPOS_ROOT="$HOME/projects/benchmark"
mkdir -p "$BENCH_REPOS_ROOT" && cd "$BENCH_REPOS_ROOT"

git clone --filter=blob:none https://github.com/calcom/cal.com.git        cal.com
git clone --filter=blob:none https://github.com/getsentry/sentry.git      sentry
git clone --filter=blob:none https://github.com/keycloak/keycloak.git     keycloak
git clone --filter=blob:none https://github.com/grafana/grafana.git       grafana
git clone --filter=blob:none https://github.com/discourse/discourse.git   discourse
```

`--filter=blob:none` corta bastante disco e tempo; o harness busca os blobs que
precisar sob demanda.

Dois detalhes que já custaram rodadas:

- **`ai-code-review-evaluation/sentry-greptile`** aparece no dataset como nome
  de repositório, mas todos os refs dele resolvem dentro do clone do
  `getsentry/sentry`. O mapeamento já cobre isso — não crie uma pasta separada.
- Alguns PRs vêm de **fork**. O commit `head` não está no clone; o harness
  busca `refs/pull/<N>/head` do upstream na primeira vez. Isso exige rede e
  pode demorar no primeiro uso daquele caso.

### Espaço em disco

Os cinco clones somam **~15-25 GB**. Some os worktrees: o harness cria um por
PR em `$BENCH_REPOS_ROOT/.worktrees/` e remove no fim, mas com concorrência 4
há até 4 vivos ao mesmo tempo. Deixe **~40 GB** livres.

### Verificação

```bash
for d in cal.com sentry keycloak grafana discourse; do
  git -C "$BENCH_REPOS_ROOT/$d" rev-parse --is-inside-work-tree >/dev/null \
    && echo "ok   $d" || echo "FALTA $d"
done
```

---

## 3. Credenciais

Coloque tudo em `.env.local` na raiz (ele tem precedência sobre `.env`).
**Nunca commite esse arquivo.**

### 3.1 Modelo que faz a review

Depende do modelo escolhido. O mapeamento está em `evals/shared/tier0-models.js`:

| modelo | variável |
|---|---|
| `deepseek-v4.1-flash@fireworks` | `API_FIREWORKS_API_KEY` ou `FIREWORKS_API_KEY` |
| `deepseek-v4-flash` (nativo) | `BYOK_DEEPSEEK_API_KEY` ou `API_DEEPSEEK_API_KEY` |
| `gpt-5.4`, `gpt-5.4-mini` | `BYOK_OPENAI_API_KEY` ou `API_OPEN_AI_API_KEY` |
| `claude-sonnet-4-6` | `API_ANTHROPIC_API_KEY` |
| `kimi-k2.7-code` | `BYOK_MOONSHOT_API_KEY` |
| `glm-5.2` | `BYOK_ZHIPU_API_KEY` |

### 3.2 Modelos de assinatura (`@sub`)

`gpt-5.6-sol@sub`, `gpt-5.6-luna@sub`, `gpt-5.6-terra@sub` **não usam chave de
API**. A credencial vem do OAuth do Codex CLI, em `~/.codex/auth.json`:

```bash
codex login
```

Duas armadilhas:

- **Cota, não chave.** O erro `The usage limit has been reached` significa cota
  do plano ChatGPT esgotada, não credencial inválida. Refazer login não
  resolve; a cota reseta por período.
- **O token vale dias.** Se `~/.codex/auth.json` tem token válido, `codex login`
  pode nem reescrever o arquivo. Confira a validade antes de culpar o login:

```bash
node -e "const j=require(require('os').homedir()+'/.codex/auth.json');
const p=JSON.parse(Buffer.from(j.tokens.access_token.split('.')[1],'base64url'));
console.log('expira em', new Date(p.exp*1000).toISOString(), '| expirado?', p.exp*1000<Date.now());"
```

### 3.3 Judge

O judge é quem decide se um achado casa com um golden. **Sem ele não existe
métrica nenhuma.**

```
JUDGE_MODEL   default: claude-haiku-4-5
```

A chave é resolvida nesta ordem:

1. `JUDGE_API_KEY` — **use esta**. O setup do modelo da review sobrescreve
   `API_OPEN_AI_API_KEY` com a chave do provedor que estiver rodando (Fireworks,
   por exemplo). Um judge que resolvesse por nome mandaria a chave errada.
2. por provedor do `JUDGE_MODEL`:
   - anthropic: `API_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY`, `BYOK_ANTHROPIC_API_KEY`
   - openai: `API_OPEN_AI_API_KEY`, `BYOK_OPENAI_API_KEY`, `OPENAI_API_KEY`
   - google: `API_GOOGLE_AI_API_KEY`, `BYOK_GOOGLE_API_KEY`, `GEMINI_API_KEY`
3. lendo `.env.local`, `.env`, `~/.kodus-dev/config`

### 3.4 Outras

| variável | obrigatória? | para quê |
|---|---|---|
| `API_CRYPTO_KEY` | **sim** | `libs/common/utils/crypto.ts` explode no import sem ela |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | não | tracing. Sem elas o harness roda, só não grava trace |

> **Nunca** coloque credencial de produção em arquivo versionado. Se precisar de
> acesso a prod, use o caminho que já existe e mantenha fora do git.

---

## 4. Conjunto de casos e gabarito

Já estão no repositório, nada a baixar:

| o quê | onde |
|---|---|
| datasets por PR (58 arquivos) | `evals/investigation/datasets/` |
| gabarito v002 | `evals/benchmark-sets/v002/goldens.json` |
| os 30 PRs do conjunto leve | `LIGHT_CASES` em `evals/investigation/recall-tests.js` |
| cópia congelada dos 30 ids | `evals/investigation/light-30.json` |

**O universo oficial é 30 PRs / 120 goldens / 111 core.** Nunca reporte número
sobre 29 ou qualquer outro recorte. PR que não gerou comentário nenhum entra na
conta do mesmo jeito, com 0 achados e os goldens dele no denominador.

---

## 5. Grafo (`kodus-graph`) — só se for testar com grafo

O grafo **não faz parte do fluxo padrão**. Ele só é construído quando a rodada
liga `RECALL_CALL_GRAPH=1`.

> **Resultado já medido:** mandar o grafo no prompt dos microagentes **piora** —
> −0,049 de F1 no DeepSeek e −0,019 no GPT. Só ligue se o objetivo for
> especificamente re-testar isso.

### Preparar

`kodus-graph` precisa estar clonado e compilado **ao lado** do `kodus-ai`:

```
<pasta-pai>/
├── kodus-ai/          <- este repositório
└── kodus-graph/
    └── dist/cli.js    <- é este arquivo que o harness chama
```

```bash
cd <pasta-pai>
git clone <url-do-kodus-graph> kodus-graph
cd kodus-graph
bun install
bun run build          # precisa produzir dist/cli.js
```

Overrides, se o layout for outro:

| variável | default |
|---|---|
| `KODUS_GRAPH_CLI` | `../../../kodus-graph/dist/cli.js` (relativo a `evals/investigation/`) |
| `BUN_BIN` | `~/.bun/bin/bun` |

### Gerar os grafos

```bash
node evals/investigation/build-pr-callgraph.js
```

O que ele faz: para cada PR, cria um worktree no commit **base**, roda
`parse --all` do `kodus-graph` sobre a árvore inteira e guarda o resultado em
`$BENCH_REPOS_ROOT/.callgraph/`. O cache é invalidado pela chave dos arquivos do
PR.

Três armadilhas já pagas com rodadas inteiras:

- **`parse --all`, não o caminho legado.** O legado parseia só os arquivos do
  diff, então a lista de chamadores nunca sai do diff — que é exatamente o
  ponto do grafo.
- **Diff de três pontos.** A comparação é `base...head`. Dois pontos pega
  mudanças que não são do PR.
- **Cache velho é veneno silencioso.** Grafos construídos antes de uma mudança
  no diff descrevem outro conjunto de arquivos e não dão erro nenhum. Na dúvida,
  apague `$BENCH_REPOS_ROOT/.callgraph/` e gere de novo.

### Ligar na rodada

```bash
RECALL_CALL_GRAPH=1 RECALL_MICRO_GRAPH=1 ...
```

As duas andam juntas: a primeira **constrói** o blob, a segunda **manda** no
prompt. Ligar só a segunda não faz nada, em silêncio.

---

## 6. Cache de disco e limpeza

| diretório | o que guarda | pode apagar? |
|---|---|---|
| `$BENCH_REPOS_ROOT/<repo>` | clones | não (caro de refazer) |
| `$BENCH_REPOS_ROOT/.worktrees/` | worktrees por PR | sim, se sobrou de run interrompido |
| `$BENCH_REPOS_ROOT/.callgraph/` | cache de grafo | sim (e às vezes deve) |
| `evals/investigation/pools/<rodada>/` | dumps crus por PR | **não** — é a matéria-prima de toda análise |
| `evals/investigation/results/` | matrizes, seletores, scores, relatórios | não |

Worktrees órfãos de uma rodada morta:

```bash
rm -rf "$BENCH_REPOS_ROOT/.worktrees"/*
for d in cal.com sentry keycloak grafana discourse; do
  git -C "$BENCH_REPOS_ROOT/$d" worktree prune
done
```

---

## 7. Verificação final

Rode isto antes da primeira rodada. Se qualquer linha der `FALTA`, pare e
resolva — rodar com ambiente incompleto produz número que parece válido.

```bash
cd <raiz-do-kodus-ai>

# 1. toolchain
node -v && pnpm -v && python3 -V

# 2. clones
: "${BENCH_REPOS_ROOT:=$HOME/projects/benchmark}"
for d in cal.com sentry keycloak grafana discourse; do
  git -C "$BENCH_REPOS_ROOT/$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && echo "ok   repo $d" || echo "FALTA repo $d"
done

# 3. dataset e gabarito
[ -d evals/investigation/datasets ] && echo "ok   datasets" || echo "FALTA datasets"
[ -f evals/benchmark-sets/v002/goldens.json ] && echo "ok   goldens" || echo "FALTA goldens"

# 4. chaves
node -e "
require('dotenv').config({path:'.env'});
require('dotenv').config({path:'.env.local',override:true});
const req=['API_CRYPTO_KEY'];
for(const k of req) console.log((process.env[k]?'ok   ':'FALTA ')+k);
const judge=process.env.JUDGE_API_KEY||process.env.API_ANTHROPIC_API_KEY||process.env.ANTHROPIC_API_KEY;
console.log((judge?'ok   ':'FALTA ')+'chave do judge');
"

# 5. credencial de assinatura (só se for usar modelo @sub)
[ -f ~/.codex/auth.json ] && echo "ok   codex auth" || echo "FALTA codex login"

# 6. grafo (só se for usar)
[ -f ../kodus-graph/dist/cli.js ] && echo "ok   kodus-graph" || echo "(sem grafo)"
```

Teste de fumaça — uma chamada real ao modelo que você vai usar:

```bash
cd evals/investigation && node -e "
require('dotenv').config({path:'../../.env'});
require('dotenv').config({path:'../../.env.local',override:true});
require('ts-node/register/transpile-only'); require('tsconfig-paths/register');
const {generateText}=require('ai'); const {buildModel}=require('./eval-model');
generateText({model:buildModel(process.argv[1]),prompt:'Reply with: ok'})
 .then(r=>console.log('MODELO OK ->',r.text.trim()))
 .catch(e=>console.log('MODELO FALHOU ->',String(e.message).slice(0,160)));
" deepseek-v4.1-flash@fireworks
```

Com tudo verde, siga para o `instructions-eval.md`.
