# Webhook Monitor Improvement Plan

## Contexto do Incidente (23/03/2026)

Um alerta de "webhook failure rate 22.2%" disparou no BetterStack às 12:20 UTC, acordando o time inteiro. Após investigação profunda via AWS CLI (ECS, ALB, CloudWatch Logs), descobrimos que:

- **A infraestrutura estava 100% saudável** — zero 5xx no ALB, zero unhealthy hosts, zero connection errors, response times normais (2-3ms avg)
- **Não houve deploy** no período (último deploy foi 20/03 às 14:06 UTC)
- **A causa real foram erros de clientes**, não problemas internos:
  1. **Confetil** — token Azure DevOps expirado (401 Unauthorized) gerando falhas no PR#1481 e PR#1476
  2. **Firstview** — créditos Anthropic API esgotados (BYOK) gerando 86 erros de "Insufficient AI Credits" no PR#354
- O alerta disparou e resolveu automaticamente em segundos porque os erros eram concentrados nesses 2 clientes

**Problema**: O monitor não distingue falhas de infraestrutura de falhas causadas por problemas do cliente. Um token expirado de UM cliente acorda o time inteiro.

---

## Arquitetura Atual

### Fluxo do Webhook

```
Webhook HTTP request
  → Webhook Service (porta 3332) responde 200/204 imediatamente
  → EnqueueWebhookUseCase cria job WEBHOOK_PROCESSING no banco
  → Worker pega o job via RabbitMQ (outbox pattern)
  → JobProcessorRouterService.process() → WebhookProcessingJobProcessorService.process()
  → Handler específico (GitHub/GitLab/Azure/Bitbucket/Forgejo).execute()
  → handler.execute() chama savePullRequestUseCase + enqueueCodeReviewJobUseCase
  → Se handler.execute() lança erro → job marcado como FAILED
  → Se sucesso → job marcado como COMPLETED
```

### Fluxo do Alerta

```
WebhookFailureMonitorService (cron a cada 5 min)
  → Query SQL: conta FAILED vs (COMPLETED + FAILED) nos últimos 30 min
  → Calcula failureRate = (failed / total) * 100
  → Se >= 10% → incidentManager.failHeartbeat() → POST para BetterStack /fail
  → Se < 10% → incidentManager.pingHeartbeat() → GET para BetterStack (tudo ok)
```

---

## Arquivos Relevantes e Estado Atual

### 1. WebhookFailureMonitorService (O MONITOR — onde o alerta é decidido)

**Arquivo**: `libs/core/infrastructure/metrics/webhook-failure-monitor.service.ts`

```typescript
@Injectable()
export class WebhookFailureMonitorService {
    private readonly thresholdPercent: number; // default: 10
    private readonly windowMinutes: number;    // default: 30

    @Cron('*/5 * * * *')
    async checkWebhookFailureRate(): Promise<void> {
        const since = new Date(Date.now() - this.windowMinutes * 60 * 1000);

        const result = await this.jobRepository
            .createQueryBuilder('job')
            .select(
                "COUNT(*) FILTER (WHERE job.status = 'FAILED')",  // CONTA TUDO IGUAL
                'failed',
            )
            .addSelect(
                "COUNT(*) FILTER (WHERE job.status IN ('COMPLETED', 'FAILED'))",
                'total',
            )
            .where('job.workflowType = :type', {
                type: WorkflowType.WEBHOOK_PROCESSING,
            })
            .andWhere('job.updatedAt >= :since', { since })
            .getRawOne();

        const failed = parseInt(result?.failed ?? '0', 10);
        const total = parseInt(result?.total ?? '0', 10);

        const failureRate = (failed / total) * 100;

        if (failureRate >= this.thresholdPercent) {
            // PROBLEMA: manda alerta sem contexto nenhum
            await this.incidentManager.failHeartbeat(
                'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                `Webhook failure rate is ${failureRate.toFixed(1)}% (threshold: ${this.thresholdPercent}%) over the last ${this.windowMinutes} minutes. Failed: ${failed}, Total: ${total}.`,
            );
        } else {
            await this.incidentManager.pingHeartbeat(
                'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
            );
        }
    }
}
```

**Problemas**:
- Conta ALL FAILED jobs sem distinção de tipo de erro
- Não filtra por `errorClassification`
- Mensagem do alerta não tem breakdown (interno vs externo)
- Não indica qual cliente/org está causando as falhas

---

### 2. JobProcessorRouterService (ONDE O ERRO É CLASSIFICADO)

**Arquivo**: `libs/core/workflow/infrastructure/job-processor-router.service.ts`

```typescript
// Linha 53-86
catch (error) {
    const isTimeout = error.message?.includes('timeout after');

    await this.jobRepository.update(jobId, {
        status: JobStatus.FAILED,
        errorClassification: isTimeout
            ? ErrorClassification.RETRYABLE
            : ErrorClassification.PERMANENT,  // TUDO que não é timeout = PERMANENT
        lastError: error.message,
    });
}
```

**Problema**: Classifica TUDO como `PERMANENT` exceto timeouts. Não distingue:
- 401/403 (token expirado do cliente)
- "Insufficient AI Credits" (BYOK sem créditos)
- Bugs internos reais

---

### 3. ErrorClassifierService (JÁ EXISTE, MAS ORPHANED)

**Arquivo**: `libs/core/workflow/infrastructure/error-classifier.service.ts`

```typescript
@Injectable()
export class ErrorClassifierService implements IErrorClassifierService {
    async classify(error: Error): Promise<ErrorClassification> {
        // Erros de rede/timeout são retryable
        if (
            error.message.includes('timeout') ||
            error.message.includes('network') ||
            error.message.includes('ECONNREFUSED') ||
            error.message.includes('ETIMEDOUT')
        ) {
            return ErrorClassification.RETRYABLE;
        }

        // Erros de validação são non-retryable
        if (
            error.message.includes('validation') ||
            error.message.includes('invalid') ||
            error.message.includes('not found') ||
            error.message.includes('unauthorized')
        ) {
            return ErrorClassification.NON_RETRYABLE;
        }

        // Por padrão, assume retryable
        return ErrorClassification.RETRYABLE;
    }
}
```

**Contrato**: `libs/core/workflow/domain/contracts/error-classifier.service.contract.ts`

**Status**: Definido e implementado, mas **nunca injetado em nenhum module** e **nunca usado por nenhum service**. Completamente orphaned.

---

### 4. ErrorClassification Enum

**Arquivo**: `libs/core/workflow/domain/enums/error-classification.enum.ts`

```typescript
export enum ErrorClassification {
    RETRYABLE = 'RETRYABLE',
    NON_RETRYABLE = 'NON_RETRYABLE',  // EXISTE NO ENUM E NO BANCO, NUNCA USADO
    CIRCUIT_OPEN = 'CIRCUIT_OPEN',     // EXISTE NO ENUM E NO BANCO, NUNCA USADO
    PERMANENT = 'PERMANENT',
}
```

**Migration original** (`libs/core/infrastructure/database/typeorm/migrations/1766092668018-inboxOutboxWorkflow.ts`):
```sql
CREATE TYPE error_classification_enum AS ENUM ('RETRYABLE', 'NON_RETRYABLE', 'CIRCUIT_OPEN', 'PERMANENT')
```

**IMPORTANTE**: `NON_RETRYABLE` já existe no schema do banco. Zero migration necessária.

---

### 5. WorkflowJobModel (Schema do banco)

**Arquivo**: `libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model.ts`

Campos relevantes para esta task:
- `status: JobStatus` — PENDING, PROCESSING, COMPLETED, FAILED, WAITING_FOR_EVENT, CANCELLED
- `errorClassification?: ErrorClassification` — nullable, enum com 4 valores
- `lastError?: string` — texto livre com a mensagem de erro
- `metadata?: Record<string, unknown>` — JSONB, contém platformType, event, etc.
- `organizationId?: string` — ID da org (pode ser null em alguns jobs)
- `teamId?: string` — ID do team

---

### 6. WebhookProcessingJobProcessorService (PROCESSOR DO WEBHOOK)

**Arquivo**: `libs/automation/webhook-processing/webhook-processing-job.processor.ts`

```typescript
// Linha 158-181 — catch block
catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    this.logger.error({
        message: `WEBHOOK_PROCESSING job ${jobId} failed`,
        // ...metadata
    });

    await this.jobRepository.update(jobId, {
        status: JobStatus.FAILED,
        errorClassification: ErrorClassification.PERMANENT,  // HARDCODED PERMANENT
        lastError: errorMessage,
    });

    throw error;  // re-throws para JobProcessorRouterService
}
```

**Nota**: O job é marcado FAILED AQUI e depois o JobProcessorRouterService também tenta marcar FAILED (double update). A classificação do Router sobrescreve a do Processor.

---

### 7. Outros Monitors (para referência de padrão)

**ErrorRateMonitorService**: `libs/core/infrastructure/metrics/error-rate-monitor.service.ts`
- Monitora HTTP error rate a cada 1 minuto
- Threshold: 10% warning, 25% critical
- Mesmo padrão: contagem cega sem distinção

**ReviewResponseMonitorService**: `libs/core/infrastructure/metrics/review-response-monitor.service.ts`
- Monitora latência de code review a cada 5 min
- Calcula P50, P95, avg
- Melhor contexto no alerta (inclui breakdown de percentis)

---

### 8. BetterStack Client

**Arquivo**: `libs/core/infrastructure/incident/betterstack.client.ts`

- `pingHeartbeat(url)` — GET request simples (estou vivo)
- `failHeartbeat(url, message?)` — POST para `{url}/fail` com mensagem texto livre
- Circuit breaker: abre após 3 falhas consecutivas, fica aberto 60s
- Timeout: 10s por request

### 9. IncidentManagerService

**Arquivo**: `libs/core/infrastructure/incident/incident-manager.service.ts`

- `pingHeartbeat(envKey)` — resolve env var e chama BetterStack ping
- `failHeartbeat(envKey, message)` — resolve env var e chama BetterStack fail
- Deduplication: 5 min window (mas só para incidents, não para heartbeats)

### 10. Handlers dos Webhooks (para contexto)

Todos os handlers seguem o mesmo padrão:

| Handler | Arquivo | Re-throws? |
|---------|---------|-----------|
| GitHub | `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts` | Sim (linha 284) |
| GitLab | `libs/platform/infrastructure/webhooks/gitlab/gitlabPullRequest.handler.ts` | Sim (linha 324) |
| Azure | `libs/platform/infrastructure/webhooks/azure/azureReposPullRequest.handler.ts` | Sim (linha 344) |
| Bitbucket | `libs/platform/infrastructure/webhooks/bitbucket/bitbucketPullRequest.handler.ts` | Sim (linha 310) |

Quando um handler re-throws, o `WebhookProcessingJobProcessorService` captura, marca FAILED, e re-throws novamente para o `JobProcessorRouterService`.

---

## Erros que causaram o incidente (exemplos reais dos logs)

### Azure DevOps 401 (Confetil — token expirado)
```json
{
  "level": "error",
  "msg": "Failed to get files for Azure Repos PR #1481 in repo Confetil.ERP.API",
  "err": { "message": "Request failed with status code 401" }
}
```

### Anthropic BYOK sem créditos (Firstview)
```json
{
  "level": "error",
  "msg": "Error running prompt: safeguardAgentVerification_turn0",
  "err": {
    "message": "Insufficient AI Credits",
    "status": 400,
    "error": {
      "type": "invalid_request_error",
      "message": "Your credit balance is too low to access the Anthropic API."
    }
  },
  "metadata": {
    "organizationName": "Firstview",
    "organizationId": "c126acf7-ccf2-4839-8697-ffe7ae9a2311",
    "prNumber": 354,
    "byokConfig": { "main": { "provider": "anthropic", "model": "claude-opus-4-5-20251101" } }
  }
}
```

### Postgres idle timeout (TypeORM)
```json
{
  "level": "warn",
  "context": "TypeORM",
  "msg": "Postgres pool raised an error. error: terminating connection due to idle-session timeout"
}
```

### ECS Task Protection 404 (ruído nos logs)
```json
{
  "level": "error",
  "msg": "Failed to enable task protection. URI: http://169.254.170.2/task-protection/v1/state - Error: Request failed with status code 404"
}
```

---

## Plano de Implementação

### Mudança 1 — Melhorar o ErrorClassifierService

**Arquivo**: `libs/core/workflow/infrastructure/error-classifier.service.ts`

Expandir os patterns para cobrir os erros reais encontrados:

```typescript
async classify(error: Error): Promise<ErrorClassification> {
    const msg = error.message?.toLowerCase() ?? '';

    // Erros de autenticação/autorização do cliente (token expirado, etc.)
    if (
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('authentication failed') ||
        msg.includes('access token')
    ) {
        return ErrorClassification.NON_RETRYABLE;
    }

    // Erros de billing/créditos do cliente (BYOK)
    if (
        msg.includes('insufficient') && msg.includes('credit') ||
        msg.includes('balance') && msg.includes('too low') ||
        msg.includes('billing') ||
        msg.includes('quota exceeded') ||
        msg.includes('rate limit')
    ) {
        return ErrorClassification.NON_RETRYABLE;
    }

    // Erros de rede/timeout são retryable
    if (
        msg.includes('timeout') ||
        msg.includes('network') ||
        msg.includes('econnrefused') ||
        msg.includes('etimedout') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up')
    ) {
        return ErrorClassification.RETRYABLE;
    }

    // Erros de validação
    if (
        msg.includes('validation') ||
        msg.includes('invalid') ||
        msg.includes('not found')
    ) {
        return ErrorClassification.NON_RETRYABLE;
    }

    // Default: PERMANENT (erro interno desconhecido — queremos saber sobre estes)
    return ErrorClassification.PERMANENT;
}
```

### Mudança 2 — Conectar o ErrorClassifierService no Module

O service precisa ser registrado no module do workflow para poder ser injetado.

Verificar qual module registra o `JobProcessorRouterService` e adicionar o `ErrorClassifierService` como provider.

### Mudança 3 — Usar ErrorClassifierService no JobProcessorRouterService

**Arquivo**: `libs/core/workflow/infrastructure/job-processor-router.service.ts`

```typescript
// Injetar o ErrorClassifierService
constructor(
    // ...existing deps
    private readonly errorClassifier: ErrorClassifierService,
) {}

// No catch block (linha 53-86):
catch (error) {
    const isTimeout = error.message?.includes('timeout after');
    const classification = isTimeout
        ? ErrorClassification.RETRYABLE
        : await this.errorClassifier.classify(error);

    await this.jobRepository.update(jobId, {
        status: JobStatus.FAILED,
        errorClassification: classification,
        lastError: error.message,
    });
}
```

### Mudança 4 — Melhorar o WebhookFailureMonitorService

**Arquivo**: `libs/core/infrastructure/metrics/webhook-failure-monitor.service.ts`

```typescript
@Cron('*/5 * * * *')
async checkWebhookFailureRate(): Promise<void> {
    const since = new Date(Date.now() - this.windowMinutes * 60 * 1000);

    const result = await this.jobRepository
        .createQueryBuilder('job')
        .select(
            "COUNT(*) FILTER (WHERE job.status = 'FAILED')",
            'totalFailed',
        )
        .addSelect(
            "COUNT(*) FILTER (WHERE job.status = 'FAILED' AND (job.errorClassification IS NULL OR job.errorClassification IN ('PERMANENT', 'RETRYABLE')))",
            'internalFailed',
        )
        .addSelect(
            "COUNT(*) FILTER (WHERE job.status = 'FAILED' AND job.errorClassification = 'NON_RETRYABLE')",
            'externalFailed',
        )
        .addSelect(
            "COUNT(*) FILTER (WHERE job.status IN ('COMPLETED', 'FAILED'))",
            'total',
        )
        .where('job.workflowType = :type', {
            type: WorkflowType.WEBHOOK_PROCESSING,
        })
        .andWhere('job.updatedAt >= :since', { since })
        .getRawOne();

    const totalFailed = parseInt(result?.totalFailed ?? '0', 10);
    const internalFailed = parseInt(result?.internalFailed ?? '0', 10);
    const externalFailed = parseInt(result?.externalFailed ?? '0', 10);
    const total = parseInt(result?.total ?? '0', 10);

    if (total === 0) {
        await this.incidentManager.pingHeartbeat(
            'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
        );
        return;
    }

    // Só conta falhas INTERNAS para o threshold
    const internalFailureRate = (internalFailed / total) * 100;

    // Log sempre para visibilidade (mesmo quando não alerta)
    if (totalFailed > 0) {
        this.logger.warn({
            message: 'Webhook failure breakdown',
            context: WebhookFailureMonitorService.name,
            metadata: {
                total,
                totalFailed,
                internalFailed,
                externalFailed,
                internalFailureRate: internalFailureRate.toFixed(1),
                windowMinutes: this.windowMinutes,
            },
        });
    }

    if (internalFailureRate >= this.thresholdPercent) {
        await this.incidentManager.failHeartbeat(
            'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
            `Webhook failure rate is ${internalFailureRate.toFixed(1)}% (threshold: ${this.thresholdPercent}%) over the last ${this.windowMinutes} minutes. Internal failures: ${internalFailed}, External (auth/billing): ${externalFailed}, Total: ${total}.`,
        );
    } else {
        await this.incidentManager.pingHeartbeat(
            'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
        );
    }
}
```

### Mudança 5 (Opcional) — Também classificar no WebhookProcessingJobProcessorService

**Arquivo**: `libs/automation/webhook-processing/webhook-processing-job.processor.ts`

O processor marca FAILED na linha 174-178 antes de re-throw. Se quiser que a classificação já esteja correta antes do Router sobrescrever:

```typescript
// Injetar ErrorClassifierService e usar no catch
const classification = error instanceof Error
    ? await this.errorClassifier.classify(error)
    : ErrorClassification.PERMANENT;

await this.jobRepository.update(jobId, {
    status: JobStatus.FAILED,
    errorClassification: classification,
    lastError: errorMessage,
});
```

**Nota**: Isso é opcional porque o `JobProcessorRouterService` sobrescreve a classificação no catch dele. Mas é mais correto classificar nos dois pontos para consistência.

---

## Resumo das Mudanças

| # | Arquivo | O que fazer | Migration? |
|---|---------|------------|-----------|
| 1 | `error-classifier.service.ts` | Expandir patterns (401, 403, BYOK credits, etc.) | Não |
| 2 | Module do workflow | Registrar ErrorClassifierService como provider | Não |
| 3 | `job-processor-router.service.ts` | Injetar e usar ErrorClassifierService em vez de hardcoded PERMANENT | Não |
| 4 | `webhook-failure-monitor.service.ts` | Separar contagem interna/externa, só alertar em falhas internas, enriquecer mensagem | Não |
| 5 | `webhook-processing-job.processor.ts` | (Opcional) Também classificar aqui para consistência | Não |

**Zero migrations. O valor `NON_RETRYABLE` já existe no banco desde a migration original.**

---

## Resultado Esperado

### Antes (hoje)
```
Alerta: Webhook failure rate is 22.2% (threshold: 10%) over the last 30 minutes. Failed: 16, Total: 72.
→ Time acordado, 30+ min de investigação manual, causa: token de cliente expirado
```

### Depois
```
Log (warn): Webhook failure breakdown — total=72, totalFailed=16, internalFailed=0, externalFailed=16
→ Heartbeat: ping (tudo ok, são só falhas externas)
→ Time dorme tranquilo
```

Se fosse um bug interno real:
```
Alerta: Webhook failure rate is 15.0% (threshold: 10%) over the last 30 minutes. Internal failures: 11, External (auth/billing): 5, Total: 72.
→ Time sabe imediatamente que são falhas internas e tem contexto para investigar
```

---

## Notas para Implementação

1. **O ErrorClassifierService usa `error.message`** — os erros de 401/403 chegam como "Request failed with status code 401" (axios) ou "Unauthorized" dependendo da fonte. Testar com os patterns reais dos logs.

2. **O double-update existe** — WebhookProcessingJobProcessorService marca FAILED, depois JobProcessorRouterService marca FAILED de novo sobrescrevendo. A classificação final é a do Router. Se implementar a Mudança 5, ambos classificam igual.

3. **Jobs antigos no banco terão `errorClassification = PERMANENT` ou `NULL`** — o monitor deve tratar NULL como "internal" (pode ser de antes da classificação existir). A query proposta já faz isso: `errorClassification IS NULL OR errorClassification IN ('PERMANENT', 'RETRYABLE')`.

4. **Considerar adicionar organizationId/teamId ao log de breakdown** — para identificar rapidamente qual cliente está com problema sem precisar ir aos logs do CloudWatch.
