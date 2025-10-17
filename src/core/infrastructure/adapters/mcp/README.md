# Kodus MCP Server

Este módulo expõe funcionalidades do Kodus através do protocolo MCP (Model Context Protocol), permitindo que aplicações externas consumam operações de gerenciamento de código, automações, code review, organização, issues, webhooks e uso de tokens.

## 📋 Índice

- [Funcionalidades Disponíveis](#funcionalidades-disponíveis)
- [Uso](#uso)
- [Tools MCP por Categoria](#tools-mcp-por-categoria)
- [Arquitetura](#arquitetura)
- [Tecnologias](#tecnologias)
- [Características](#características)
- [Extensão](#extensão)

## Funcionalidades Disponíveis

### Total de Tools: 41

#### 📦 Code Management (11 tools)
Gerenciamento de repositórios, PRs, commits e arquivos

#### 📏 Kody Rules (5 tools)
Gerenciamento de regras customizadas do Kody

#### 🤖 Automation (4 tools)
Gerenciamento de automações e execuções

#### 💬 Code Review (3 tools)
Feedbacks e sugestões de code review

#### 🏢 Organization (5 tools)
Gerenciamento de organizações, teams e membros

#### 🐛 Issues (4 tools)
Gerenciamento de issues detectadas

#### 🔔 Webhook (3 tools)
Logs de webhooks recebidos

#### 📊 Usage (3 tools)
Estatísticas de uso de tokens e custos

## Uso

### Iniciar o MCP Server

```bash
# Via script npm
npm run mcp:server

# Ou diretamente
yarn mcp:server
```

### Configuração do Cliente MCP

```typescript
import { createMCPAdapter } from '@kodus/flow';

const mcpAdapter = createMCPAdapter({
  servers: [
    {
      name: 'kodus-mcp-server',
      command: 'npm',
      args: ['run', 'mcp:server']
    }
  ]
});
```

## Tools MCP por Categoria

### 📦 Code Management Tools

#### 1. KODUS_LIST_REPOSITORIES
Lista todos os repositórios acessíveis ao time.

```json
{
  "name": "KODUS_LIST_REPOSITORIES",
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

#### 2. KODUS_LIST_PULL_REQUESTS
Lista pull requests com filtros avançados.

```json
{
  "name": "KODUS_LIST_PULL_REQUESTS",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "filters": {
      "state": "opened",
      "repository": {
        "id": "repo-id",
        "name": "repo-name"
      },
      "author": "developer",
      "startDate": "2024-01-01",
      "endDate": "2024-12-31"
    }
  }
}
```

#### 3. KODUS_LIST_COMMITS
Lista commits de repositórios.

```json
{
  "name": "KODUS_LIST_COMMITS",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "filters": {
      "since": "2024-01-01T00:00:00Z",
      "until": "2024-12-31T23:59:59Z",
      "author": "developer@example.com",
      "branch": "main"
    }
  }
}
```

#### 4. KODUS_GET_PULL_REQUEST
Obtém detalhes completos de um pull request incluindo arquivos modificados.

```json
{
  "name": "KODUS_GET_PULL_REQUEST",
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

#### 5. KODUS_GET_REPOSITORY_FILES
Lista arquivos de um repositório com filtros de padrão.

```json
{
  "name": "KODUS_GET_REPOSITORY_FILES",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "branch": "main",
    "filePatterns": ["**/*.ts", "src/**/*.js"],
    "excludePatterns": ["node_modules/**", "**/*.log"],
    "maxFiles": 1000
  }
}
```

#### 6. KODUS_GET_REPOSITORY_CONTENT
Obtém conteúdo de um arquivo específico do repositório.

```json
{
  "name": "KODUS_GET_REPOSITORY_CONTENT",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "organizationName": "my-org",
    "filePath": "src/components/Button.tsx",
    "branch": "main"
  }
}
```

#### 7. KODUS_GET_REPOSITORY_LANGUAGES
Obtém breakdown de linguagens de programação do repositório.

```json
{
  "name": "KODUS_GET_REPOSITORY_LANGUAGES",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    }
  }
}
```

#### 8. KODUS_GET_PULL_REQUEST_FILE_CONTENT
Obtém conteúdo modificado de um arquivo dentro do contexto do PR.

```json
{
  "name": "KODUS_GET_PULL_REQUEST_FILE_CONTENT",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "prNumber": 123,
    "filePath": "src/components/Button.tsx"
  }
}
```

#### 9. KODUS_GET_DIFF_FOR_FILE
Obtém o diff de um arquivo específico no PR.

```json
{
  "name": "KODUS_GET_DIFF_FOR_FILE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repository": {
      "id": "repo-id",
      "name": "repo-name"
    },
    "prNumber": 123,
    "filePath": "src/components/Button.tsx"
  }
}
```

#### 10. KODUS_GET_PULL_REQUEST_DIFF
Obtém o diff completo do PR (todos os arquivos).

```json
{
  "name": "KODUS_GET_PULL_REQUEST_DIFF",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "uuid-do-time",
    "repositoryId": "repo-id",
    "repositoryName": "repo-name",
    "prNumber": 123
  }
}
```

---

### 📏 Kody Rules Tools

#### 11. KODUS_GET_KODY_RULES
Lista todas as Kody Rules ativas da organização.

```json
{
  "name": "KODUS_GET_KODY_RULES",
  "arguments": {
    "organizationId": "uuid-da-organizacao"
  }
}
```

#### 12. KODUS_GET_KODY_RULES_REPOSITORY
Lista Kody Rules específicas de um repositório.

```json
{
  "name": "KODUS_GET_KODY_RULES_REPOSITORY",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryId": "repo-id"
  }
}
```

#### 13. KODUS_CREATE_KODY_RULE
Cria uma nova Kody Rule.

```json
{
  "name": "KODUS_CREATE_KODY_RULE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "kodyRule": {
      "title": "Use arrow functions for components",
      "rule": "All React components should use arrow function syntax",
      "severity": "WARNING",
      "scope": "FILE",
      "repositoryId": "repo-id",
      "path": "src/components/**/*.tsx",
      "examples": [
        {
          "snippet": "const Button = () => { ... }",
          "isCorrect": true
        },
        {
          "snippet": "function Button() { ... }",
          "isCorrect": false
        }
      ]
    }
  }
}
```

#### 14. KODUS_UPDATE_KODY_RULE
Atualiza uma Kody Rule existente.

```json
{
  "name": "KODUS_UPDATE_KODY_RULE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "ruleId": "rule-uuid",
    "kodyRule": {
      "title": "Updated title",
      "severity": "ERROR",
      "status": "ACTIVE"
    }
  }
}
```

#### 15. KODUS_DELETE_KODY_RULE
Deleta uma Kody Rule permanentemente.

```json
{
  "name": "KODUS_DELETE_KODY_RULE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "ruleId": "rule-uuid"
  }
}
```

---

### 🤖 Automation Tools

#### 16. KODUS_LIST_AUTOMATIONS
Lista todas as automações da organização.

```json
{
  "name": "KODUS_LIST_AUTOMATIONS",
  "arguments": {
    "organizationId": "uuid-da-organizacao"
  }
}
```

#### 17. KODUS_GET_AUTOMATION
Obtém detalhes de uma automação específica.

```json
{
  "name": "KODUS_GET_AUTOMATION",
  "arguments": {
    "automationId": "automation-uuid"
  }
}
```

#### 18. KODUS_LIST_AUTOMATION_EXECUTIONS
Lista histórico de execuções de automações.

```json
{
  "name": "KODUS_LIST_AUTOMATION_EXECUTIONS",
  "arguments": {
    "automationId": "automation-uuid",
    "status": "completed"
  }
}
```

#### 19. KODUS_GET_PULL_REQUEST_EXECUTIONS
Obtém execuções de automação específicas para PRs com paginação.

```json
{
  "name": "KODUS_GET_PULL_REQUEST_EXECUTIONS",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryIds": ["repo-id-1", "repo-id-2"],
    "skip": 0,
    "take": 50,
    "order": "DESC"
  }
}
```

---

### 💬 Code Review Tools

#### 20. KODUS_LIST_CODE_REVIEW_FEEDBACKS
Lista todos os feedbacks de code review.

```json
{
  "name": "KODUS_LIST_CODE_REVIEW_FEEDBACKS",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryId": "repo-id",
    "syncedEmbeddedSuggestions": false
  }
}
```

#### 21. KODUS_GET_CODE_REVIEW_FEEDBACK
Obtém detalhes de um feedback específico.

```json
{
  "name": "KODUS_GET_CODE_REVIEW_FEEDBACK",
  "arguments": {
    "feedbackId": "feedback-uuid"
  }
}
```

#### 22. KODUS_GET_CODE_REVIEW_FEEDBACKS_BY_PR
Obtém todos os feedbacks de um PR específico.

```json
{
  "name": "KODUS_GET_CODE_REVIEW_FEEDBACKS_BY_PR",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "pullRequestId": "pr-uuid"
  }
}
```

---

### 🏢 Organization Tools

#### 23. KODUS_GET_ORGANIZATION
Obtém detalhes de uma organização.

```json
{
  "name": "KODUS_GET_ORGANIZATION",
  "arguments": {
    "organizationId": "uuid-da-organizacao"
  }
}
```

#### 24. KODUS_LIST_ORGANIZATIONS
Lista organizações com filtros opcionais.

```json
{
  "name": "KODUS_LIST_ORGANIZATIONS",
  "arguments": {
    "name": "My Company",
    "platformType": "github"
  }
}
```

#### 25. KODUS_LIST_TEAMS
Lista todos os teams de uma organização.

```json
{
  "name": "KODUS_LIST_TEAMS",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "status": ["active"]
  }
}
```

#### 26. KODUS_GET_TEAM
Obtém detalhes de um team específico.

```json
{
  "name": "KODUS_GET_TEAM",
  "arguments": {
    "teamId": "team-uuid"
  }
}
```

#### 27. KODUS_LIST_TEAM_MEMBERS
Lista membros de um team.

```json
{
  "name": "KODUS_LIST_TEAM_MEMBERS",
  "arguments": {
    "teamId": "team-uuid",
    "status": "active"
  }
}
```

---

### 🐛 Issues Tools

#### 28. KODUS_LIST_ISSUES
Lista todas as issues com filtros avançados.

```json
{
  "name": "KODUS_LIST_ISSUES",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryId": "repo-id",
    "status": "open",
    "severity": "high",
    "label": "security"
  }
}
```

#### 29. KODUS_GET_ISSUE
Obtém detalhes de uma issue específica.

```json
{
  "name": "KODUS_GET_ISSUE",
  "arguments": {
    "issueId": "issue-uuid"
  }
}
```

#### 30. KODUS_GET_ISSUES_BY_FILE
Obtém todas as issues de um arquivo específico.

```json
{
  "name": "KODUS_GET_ISSUES_BY_FILE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryId": "repo-id",
    "filePath": "src/utils/auth.ts",
    "status": "open"
  }
}
```

#### 31. KODUS_COUNT_ISSUES
Obtém contagem de issues com filtros.

```json
{
  "name": "KODUS_COUNT_ISSUES",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "repositoryId": "repo-id",
    "status": "open",
    "severity": "critical"
  }
}
```

---

### 🔔 Webhook Tools

#### 32. KODUS_LIST_WEBHOOK_LOGS
Lista logs de webhooks recebidos.

```json
{
  "name": "KODUS_LIST_WEBHOOK_LOGS",
  "arguments": {
    "platform": "GITHUB",
    "event": "pull_request"
  }
}
```

#### 33. KODUS_GET_WEBHOOK_LOG
Obtém detalhes de um webhook log específico.

```json
{
  "name": "KODUS_GET_WEBHOOK_LOG",
  "arguments": {
    "webhookLogId": "webhook-log-uuid"
  }
}
```

#### 34. KODUS_GET_WEBHOOK_LOGS_BY_PLATFORM
Obtém webhooks de uma plataforma específica.

```json
{
  "name": "KODUS_GET_WEBHOOK_LOGS_BY_PLATFORM",
  "arguments": {
    "platform": "GITLAB",
    "limit": 50
  }
}
```

---

### 📊 Usage Tools

#### 35. KODUS_GET_DAILY_USAGE
Obtém uso diário de tokens e custos.

```json
{
  "name": "KODUS_GET_DAILY_USAGE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "team-uuid",
    "startDate": "2024-01-01",
    "endDate": "2024-01-31",
    "model": "gpt-4"
  }
}
```

#### 36. KODUS_GET_USAGE_SUMMARY
Obtém resumo agregado de uso.

```json
{
  "name": "KODUS_GET_USAGE_SUMMARY",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "team-uuid",
    "startDate": "2024-01-01",
    "endDate": "2024-01-31"
  }
}
```

#### 37. KODUS_GET_CURRENT_MONTH_USAGE
Obtém uso do mês atual.

```json
{
  "name": "KODUS_GET_CURRENT_MONTH_USAGE",
  "arguments": {
    "organizationId": "uuid-da-organizacao",
    "teamId": "team-uuid"
  }
}
```

---

## Arquitetura

```
src/core/infrastructure/adapters/mcp/
├── controllers/
│   └── mcp.controller.ts           # REST endpoints do MCP
├── guards/
│   └── mcp-enabled.guard.ts        # Guard de feature flag
├── services/
│   ├── mcp-server.service.ts       # Serviço principal do MCP
│   └── mcp-manager.service.ts      # Gerenciador de sessões
├── tools/
│   ├── codeManagement.tools.ts     # 11 tools de code management
│   ├── kodyRules.tools.ts          # 5 tools de Kody Rules
│   ├── automation.tools.ts         # 4 tools de automação
│   ├── codeReview.tools.ts         # 3 tools de code review
│   ├── organization.tools.ts       # 5 tools de organização
│   ├── issues.tools.ts             # 4 tools de issues
│   ├── webhook.tools.ts            # 3 tools de webhooks
│   ├── usage.tools.ts              # 3 tools de uso
│   └── index.ts                    # Exportações
├── types/
│   └── mcp-tool.interface.ts       # Interfaces base
├── utils/
│   └── mcp-protocol.utils.ts       # Utilitários do protocolo
├── mcp.module.ts                   # Módulo NestJS
└── README.md                       # Este arquivo
```

### Componentes

- **`McpServerService`**: Implementação do servidor MCP usando SDK oficial
- **`MCPManagerService`**: Gerenciamento de sessões e autenticação
- **`McpController`**: Endpoints REST para interação com o servidor
- **`*Tools`**: Classes de ferramentas organizadas por categoria
- **`McpEnabledGuard`**: Feature flag guard para habilitar/desabilitar

## Tecnologias

- **`@modelcontextprotocol/sdk`** - SDK oficial do MCP v1.13.2
- **`@nestjs/common`** - Framework NestJS
- **`zod`** - Validação de schemas
- **TypeScript** - Type safety completo

## Características

### Segurança
- ✅ Validação rigorosa via Zod schemas
- ✅ Tratamento robusto de erros
- ✅ Logging estruturado com Pino
- ✅ Isolamento por organização/equipe
- ✅ Feature flag para habilitar/desabilitar

### Performance
- ✅ Response padronizado com contadores
- ✅ Filtros avançados para reduzir payload
- ✅ Paginação em endpoints que retornam muitos dados
- ✅ Caching de sessões MCP

### Observabilidade
- ✅ Logs detalhados de execução
- ✅ Métricas de sucesso/erro
- ✅ Breakdown de tools por categoria
- ✅ Tracking de sessões ativas

## Response Format

Todos os tools retornam dados no formato padrão:

```json
{
  "success": true,
  "count": 25,
  "data": [/* array de resultados */]
}
```

Para summaries e contadores:

```json
{
  "success": true,
  "count": 1,
  "data": {
    "totalTokens": 1500000,
    "totalCost": 45.50,
    "totalRequests": 320
  }
}
```

## Extensão

Para adicionar novos tools:

### 1. Criar nova classe de tools

```typescript
// src/core/infrastructure/adapters/mcp/tools/newCategory.tools.ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';

@Injectable()
export class NewCategoryTools {
    constructor(
        private readonly someService: SomeService,
        private readonly logger: PinoLoggerService,
    ) {}

    myNewTool(): McpToolDefinition {
        const inputSchema = z.object({
            param1: z.string().describe('Description'),
            param2: z.number().optional(),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_MY_NEW_TOOL',
            description: 'What this tool does',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(z.any()),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<BaseResponse> => {
                    const result = await this.someService.doSomething(args);
                    return {
                        success: true,
                        count: result.length,
                        data: result,
                    };
                },
                'my_new_tool',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [this.myNewTool()];
    }
}
```

### 2. Exportar no index

```typescript
// src/core/infrastructure/adapters/mcp/tools/index.ts
export { NewCategoryTools } from './newCategory.tools';

export const TOOL_CATEGORIES = {
    // ... existing
    NEW_CATEGORY: 'newCategory',
} as const;
```

### 3. Registrar no módulo

```typescript
// src/core/infrastructure/adapters/mcp/mcp.module.ts
import { NewCategoryTools } from './tools';
import { NewCategoryModule } from '@/modules/newCategory.module';

// ... dentro de forRoot()
imports.push(
    forwardRef(() => NewCategoryModule),
);

providers.push(
    NewCategoryTools,
);
```

### 4. Adicionar no serviço

```typescript
// src/core/infrastructure/adapters/mcp/services/mcp-server.service.ts
constructor(
    // ... existing
    private readonly newCategoryTools: NewCategoryTools,
) {}

private registerTools(server: McpServer): void {
    const newCategoryTools = this.newCategoryTools.getAllTools();
    
    const allTools = [
        // ... existing
        ...newCategoryTools,
    ];
    // ...
}
```

## Suporte a Plataformas

O MCP Server funciona com todas as plataformas suportadas pelo Kodus:
- ✅ **GitHub** 
- ✅ **GitLab**
- ✅ **Azure Repos**
- ✅ **Bitbucket**

## Feature Flag

Para habilitar o MCP Server, configure a variável de ambiente:

```bash
API_MCP_SERVER_ENABLED=true
```

## Roadmap

- [ ] Adicionar tools de métricas de qualidade
- [ ] Implementar tools de CI/CD
- [ ] Adicionar suporte a streams para respostas grandes
- [ ] Implementar rate limiting por organização
- [ ] Adicionar caching de resultados frequentes
