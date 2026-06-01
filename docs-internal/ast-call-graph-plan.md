# AST Call Graph — Status e Plano

## O que temos hoje

Usamos `code-review-graph` (pip package, tree-sitter based, 19 linguagens) pra gerar um call graph com assinaturas de funções. O grafo é buildado no sandbox durante o review e injetado no prompt do agente.

### O que funciona
- Tree-sitter parseia o repo e gera um SQLite com funções, callers, callees, assinaturas (params + return types)
- Repos pequenos (cal.com 1.5k files, discourse 2.4k) completam em 60-90s
- As queries SQLite retornam dados ricos: `authenticate(AuthenticationFlowContext context)`, `create(event: CalendarEvent) -> Promise<CreateUpdateResult>`
- Suporta Go, Python, TypeScript, JavaScript, Java, Ruby, Rust, Kotlin, C#, PHP, Swift, etc.
- O agente recebe output tipo:

```
Changed functions (tree-sitter AST):

get_item_key(self, item, for_prev)  (api/paginator.py:130)
  ← called by get_result (api/paginator.py:189)
  → calls floor()  (math:builtin)

Callee signatures (verify callsites match):
  Exec(query string, args ...interface{}) -> (sql.Result, error)  (session.go:9)
  CountDevices(ctx context.Context, from time.Time, to time.Time) -> (int64, error)  (database.go:102)
```

### O problema: performance
- Repos grandes dão timeout: sentry (13k files, ~180s), grafana (8k, ~150s), keycloak (7k, ~120s)
- No benchmark com 50 PRs, **64% deram build timeout** (180s limit)
- Quando 10+ PRs rodam em paralelo, a CPU satura e os builds demoram mais
- Resultado: F1 caiu de 0.464 (10 PRs) pra 0.356 (50 PRs) porque a maioria não teve call graph

### Impacto no benchmark (quando funciona)
- Com call graph (10 PRs, repos que completam): F1=0.464, Precision=0.464, Recall=0.464
- Sem call graph (baseline): F1=0.338
- O call graph + assinaturas ajuda o agente a encontrar type mismatches e delegation bugs

## Arquitetura proposta: Build on Setup + Incremental Update

### Fase 1: Build quando o repo é integrado

Quando o cliente conecta um repo ao Kodus (setup/onboarding):

1. Clonar o repo (branch default)
2. Rodar `code-review-graph build` — gera `.code-review-graph/graph.db`
3. Salvar o `graph.db` em storage persistente com chave `{orgId}/{repoId}/graph.db`
4. Salvar o commit SHA usado no build como `{orgId}/{repoId}/graph-sha.txt`

Isso roda **uma vez**, fora do hot path do review. Pode demorar 3-5 min sem problema.

### Fase 2: Incremental update no review

Quando um PR é aberto e o review começa:

1. Copiar o `graph.db` do storage pro sandbox
2. Rodar `code-review-graph update` (incremental) — re-parseia só os arquivos que mudaram desde o último build
3. O update demora **<2 segundos** (vs 90-180s do build full)
4. Queries SQLite pra montar o call graph com assinaturas
5. Injetar no prompt do agente

### Fase 3: Manter atualizado via webhook

Quando um push acontece na branch default (main/master):

1. Webhook dispara job assíncrono
2. Job faz `git pull` no repo cached e roda `code-review-graph update`
3. Salva o novo `graph.db` no storage
4. Próximo review já usa o DB atualizado

### Storage options

O `graph.db` é um SQLite file. Tamanhos observados:
- cal.com (1.5k files): ~2MB
- discourse (2.4k files): ~5MB
- sentry (13k files): ~15MB
- grafana (8k files): ~10MB

Options:
- **S3/MinIO** — simples, barato, já usamos pra outros assets
- **Volume Docker persistente** — mais simples pra dev, não escala pra multi-tenant
- **Redis** — possível mas overkill pra arquivos de 5-15MB

### Esquema no banco

```sql
-- Nova tabela ou campo no repositório
ALTER TABLE repositories ADD COLUMN ast_graph_sha TEXT;
ALTER TABLE repositories ADD COLUMN ast_graph_path TEXT; -- S3 key
ALTER TABLE repositories ADD COLUMN ast_graph_updated_at TIMESTAMP;
```

### API do code-review-graph que usamos

```bash
# Build full (setup, 90-180s)
code-review-graph build

# Incremental update (review, <2s)
code-review-graph update

# Status
code-review-graph status
# → Nodes: 110234, Edges: 901671, Files: 13596

# Detect changes (blast radius)
code-review-graph detect-changes --base HEAD~1
```

### Query via Python (no sandbox)

```python
import sqlite3, json
db = sqlite3.connect(".code-review-graph/graph.db")
db.row_factory = sqlite3.Row

# Funções nos changed files
rows = db.execute("""
    SELECT name, qualified_name, params, return_type, file_path, line_start
    FROM nodes
    WHERE file_path LIKE '%paginator.py' AND kind = 'Function'
""").fetchall()

# Callers de uma função
callers = db.execute("""
    SELECT n.name, n.file_path, e.line
    FROM edges e
    JOIN nodes n ON n.qualified_name = e.source_qualified
    WHERE e.target_qualified = ? AND e.kind = 'CALLS'
""", (qualified_name,)).fetchall()

# Callees com assinaturas
callees = db.execute("""
    SELECT n.name, n.params, n.return_type, n.file_path, n.line_start
    FROM edges e
    JOIN nodes n ON n.qualified_name = e.target_qualified
    WHERE e.source_qualified = ? AND e.kind = 'CALLS'
""", (qualified_name,)).fetchall()
```

### SQLite schema do graph.db

```sql
CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,           -- File, Class, Function, Type, Test
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    language TEXT,
    parent_name TEXT,
    params TEXT,                  -- "(ctx context.Context, req *Request)"
    return_type TEXT,             -- "(*Response, error)"
    modifiers TEXT,               -- async, public, static
    is_test INTEGER DEFAULT 0,
    file_hash TEXT,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,           -- CALLS, IMPORTS_FROM, INHERITS, IMPLEMENTS, CONTAINS
    source_qualified TEXT NOT NULL,
    target_qualified TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER DEFAULT 0,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);
```

### Limitações conhecidas

1. **Ruby**: encontra funções mas params ficam vazios (sem type annotations). Callers nem sempre resolvidos (method calls como `OptimizedImage.downsize` não linkam ao edge)
2. **Java**: encontra funções com assinaturas mas callers podem falhar em hierarquias de herança complexas (Keycloak)
3. **Build time**: sentry 13k files = 90-180s. Com cache, vira <2s
4. **Paralelismo**: 10+ builds simultâneos saturam CPU. Com cache, não é problema (update é leve)

### Dependências

- `pip install code-review-graph` no ambiente que faz o build (worker ou job dedicado)
- Python 3.10+ (já temos no Dockerfile)
- `sqlite3` disponível no Python stdlib
- Storage pra persistir os graph.db files

### Referências

- Repo: https://github.com/tirth8205/code-review-graph
- Versão testada: 2.0.0
- Suporta 19+ linguagens via tree-sitter
- MIT license
