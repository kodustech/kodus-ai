# Kodus Code Management MCP Server

Este módulo expõe funcionalidades do `CodeManagementService` através do protocolo MCP (Model Context Protocol), permitindo que aplicações externas consumam as operações de gerenciamento de código do Kodus.

## Modelo de transporte HTTP

O endpoint HTTP MCP do Kodus roda em modo `Streamable HTTP` stateless.

## Contrato atual

- `initialize`, `ping`, `tools/list` e demais chamadas de descoberta podem ser feitas diretamente no endpoint MCP.
- O endpoint HTTP em si não mantém sessão entre requests e não aplica autenticação própria neste momento.
- A execução real continua dependendo das validações de domínio já existentes nos serviços e tools, incluindo contexto de organização, time e integrações ativas.
- `GET` e `DELETE` não fazem parte do contrato exposto neste deployment; o endpoint é `POST`-only.
- O objetivo atual é previsibilidade operacional atrás de load balancer, sem reintroduzir estado local por instância.

## Observabilidade e performance

- Cada request MCP gera logs canônicos de início e fim com `method`, `path`, `jsonrpcMethod`, `toolName`, `organizationId`, `teamId`, `statusCode`, `latencyMs` e `instanceId` quando aplicável.
- A execução de tools continua registrando invocação, sucesso e falha no nível do tool.
- As factories MCP permanecem stateless, mas agora cacheiam apenas a metadata estática dos tools (`name`, `description`, schemas transformados e annotations) para evitar recomputação de schema a cada `POST`.
- `McpServer` e `StreamableHTTPServerTransport` continuam sendo criados por request; nenhum estado conectado do protocolo é reutilizado.

- Cada `POST /mcp` cria um `McpServer` e um `StreamableHTTPServerTransport` novos, válidos apenas durante aquela requisição.
- O servidor não mantém `Mcp-Session-Id` em memória entre requests.
- `GET /mcp` e `DELETE /mcp` retornam `405 Method Not Allowed`.
- Todas as operações MCP neste endpoint seguem públicas no nível HTTP. Validações de tenant e integração continuam no fluxo de domínio e nos próprios tools.
- Esse desenho evita afinidade de sessão no load balancer e funciona corretamente com múltiplas instâncias ECS/EC2 atrás de ALB.

Esse comportamento é intencional. No fluxo interno do Kodus, contexto de tenant, autenticação e autorização já trafegam no request e nos argumentos dos tools. Não há dependência funcional de sessão MCP para executar `initialize`, `tools/list`, `tool/call` e `ping`.

## Funcionalidades Disponíveis

### Tools MCP Expostos

#### Code Management Tools
1. **`list_repositories`** - Lista repositórios da plataforma configurada (GitHub, GitLab, Azure Repos)
2. **`list_pull_requests`** - Lista pull requests com filtros avançados
3. **`list_commits`** - Lista commits de repositórios específicos
4. **`get_pull_request_details`** - Obtém detalhes específicos de um pull request
5. **`get_repository_files`** - Lista arquivos de um repositório com filtros

#### Kody Issues Management Tools
6. **`KODUS_CREATE_KODY_ISSUE`** - Cria uma nova issue manualmente
7. **`KODUS_LIST_KODY_ISSUES`** - Lista issues com filtros opcionais
8. **`KODUS_GET_KODY_ISSUE_DETAILS`** - Obtém detalhes de uma issue específica
9. **`KODUS_UPDATE_KODY_ISSUE_STATUS`** - Atualiza o status de uma issue
10. **`KODUS_UPDATE_KODY_ISSUE_CATEGORY`** - Atualiza a categoria/label de uma issue
11. **`KODUS_DELETE_KODY_ISSUE`** - Fecha/descarta uma issue

## Uso

### Iniciar o MCP Server

```bash
# Via script npm
npm run mcp:server

# Ou diretamente
yarn mcp:server
```

### Configuração do Cliente MCP

Para consumir este servidor MCP via HTTP:

```typescript
import { createMCPAdapter } from '@kodus/flow';

const mcpAdapter = createMCPAdapter({
  servers: [
    {
      name: 'kodus-code-management',
      type: 'http',
      url: 'https://api.kodus.io/mcp'
    }
  ]
});
```

O client `StreamableHTTPClientTransport` do SDK funciona com esse modelo porque:

- faz `GET` opcional para SSE e trata `405` como comportamento esperado;
- só passa a enviar `Mcp-Session-Id` se o servidor tiver retornado esse header no `initialize`;
- em modo stateless, como o servidor não devolve `Mcp-Session-Id`, não há afinidade entre requests.

### Exemplos de Uso dos Tools

#### 1. Listar Repositórios

```json
{
  "name": "list_repositories",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "filters": {
      "language": "typescript",
      "archived": false,
      "private": true
    }
  }
}
```

#### 2. Listar Pull Requests

```json
{
  "name": "list_pull_requests", 
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "filters": {
      "state": "open",
      "repository": "my-repo",
      "author": "developer",
      "startDate": "2024-01-01",
      "endDate": "2024-12-31"
    }
  }
}
```

#### 3. Listar Commits

```json
{
  "name": "list_commits",
  "arguments": {
    "organizationId": "uuid-da-organizacao", 
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "filters": {
      "since": "2024-01-01",
      "until": "2024-12-31",
      "author": "developer@example.com",
      "branch": "main"
    }
  }
}
```

#### 4. Detalhes de Pull Request

```json
{
  "name": "get_pull_request_details",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "prNumber": 123
  }
}
```

#### 5. Arquivos do Repositório

```json
{
  "name": "get_repository_files",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": "my-repo",
    "organizationName": "my-org",
    "branch": "main",
    "filePatterns": ["*.ts", "*.js"],
    "excludePatterns": ["node_modules/**"],
    "maxFiles": 500
  }
}
```

#### 6. Criar Kody Issue

```json
{
  "name": "KODUS_CREATE_KODY_ISSUE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "title": "Memory leak in user service",
    "description": "Detailed description of the issue",
    "filePath": "src/services/user.service.ts",
    "language": "typescript",
    "label": "bug",
    "severity": "high",
    "repository": {
      "id": "repo-id",
      "name": "my-repo"
    },
    "owner": {
      "gitId": "user123",
      "username": "johndoe"
    },
    "reporter": {
      "gitId": "reporter456",
      "username": "janedoe"
    }
  }
}
```

**Note**: `owner` and `reporter` are optional. If `reporter` is not provided, defaults to Kody-MCP.

#### 7. Listar Kody Issues

```json
{
  "name": "KODUS_LIST_KODY_ISSUES",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryName": "my-repo",
    "severity": "high",
    "label": "bug"
  }
}
```

All filters are optional.

#### 8. Detalhes de Kody Issue

```json
{
  "name": "KODUS_GET_KODY_ISSUE_DETAILS",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "issueId": "issue-uuid"
  }
}
```

#### 9. Atualizar Status de Issue

```json
{
  "name": "KODUS_UPDATE_KODY_ISSUE_STATUS",
  "arguments": {
    "issueId": "issue-uuid",
    "status": "resolved"
  }
}
```

Valid statuses: `open`, `resolved`, `dismissed`

#### 10. Atualizar Categoria de Issue

```json
{
  "name": "KODUS_UPDATE_KODY_ISSUE_CATEGORY",
  "arguments": {
    "issueId": "issue-uuid",
    "label": "performance"
  }
}
```

#### 11. Deletar/Fechar Issue

```json
{
  "name": "KODUS_DELETE_KODY_ISSUE",
  "arguments": {
    "issueId": "issue-uuid"
  }
}
```

This sets the issue status to `dismissed`.

## Arquitetura

- `libs/mcp-server/controllers/*.controller.ts`: endpoints HTTP MCP.
- `libs/mcp-server/services/*-factory.ts`: constroem `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`.
- `libs/mcp-server/services/*-server.service.ts`: coordenam o ciclo de vida por request, logging e cleanup.
- `libs/mcp-server/tools/*`: catálogo de tools expostos no protocolo.

## Quando não usar esse modelo

Se no futuro o Kodus precisar de:

- SSE iniciado por `GET`,
- resumability com `Last-Event-ID`,
- notificações servidor -> cliente fora do ciclo do `POST`,
- sessões longas com estado no transport,

o endpoint HTTP terá que voltar a um modo stateful com storage ou roteamento distribuído. Nesse cenário, memória local por instância não é suficiente atrás de load balancer.

## Tecnologias

- **`@modelcontextprotocol/sdk`** - SDK oficial do MCP v1.13.2
- **`@nestjs/common`** - Framework NestJS
- **`CodeManagementService`** - Serviço interno do Kodus
- **TypeScript** - Type safety completo

## Características

### Segurança
- Validação rigorosa via JSON Schema
- Tratamento robusto de erros com `McpError`
- Logging estruturado com NestJS Logger
- Isolamento por organização/equipe

### Performance
- Response padronizado com contadores
- Filtros avançados para reduzir payload
- Timeouts e graceful shutdown

### Observabilidade
- Logs detalhados de execução
- Métricas de sucesso/erro
- Status dos tools via `ListToolsRequestSchema`

## Response Format

Todos os tools retornam dados no formato padrão:

```json
{
  "success": true,
  "count": 25,
  "data": [/* array de resultados */]
}
```

## Extensão

Para adicionar novos tools:

1. **Definir Tool Schema**:
```typescript
{
  name: 'new_tool',
  description: 'Tool description',
  inputSchema: {
    type: 'object',
    properties: { /* definir props */ },
    required: ['requiredProp']
  }
}
```

2. **Adicionar Handler**:
```typescript
case 'new_tool':
  return await this.handleNewTool(args);
```

3. **Implementar Método**:
```typescript
private async handleNewTool(args: any): Promise<CallToolResult> {
  const result = await this.codeManagementService.someMethod(args);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        count: result.length,
        data: result
      }, null, 2)
    } as TextContent]
  };
}
```

## Suporte a Plataformas

O MCP Server funciona com todas as plataformas suportadas pelo Kodus:
- ✅ **GitHub** 
- ✅ **GitLab**
- ✅ **Azure Repos**
- ✅ **Bitbucket** (via factory pattern)
