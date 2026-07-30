import { MongoClient } from 'mongodb';
import { createLogger } from '@libs/core/log/logger';
import { MongoDBLogItem, MongoDBTelemetryItem } from './flow-types';

// Interface para a resposta da rastreabilidade
export interface TraceabilityResponse {
    correlationId: string;
    summary: {
        totalLogs: number;
        totalTelemetry: number;
        startTime?: Date;
        endTime?: Date;
        duration?: number;
        status: 'success' | 'error' | 'running';
    };
    timeline: Array<{
        timestamp: Date;
        type: 'log' | 'telemetry';
        component?: string;
        message?: string;
        name?: string;
        level?: string;
        duration?: number;
        errorMessage?: string;
        phase?: string;
        agentName?: string;
        toolName?: string;
    }>;
    details: {
        logs: MongoDBLogItem[];
        telemetry: MongoDBTelemetryItem[];
    };
    execution: {
        executionId?: string;
        agentName?: string;
        sessionId?: string;
        tenantId?: string;
        input?: unknown;
        output?: unknown;
        steps?: Array<{
            timestamp: number;
            type: string;
            component: string;
            data: Record<string, unknown>;
        }>;
    };
}

/**
 * Busca toda a rastreabilidade de uma execução baseada no correlationId
 * @param mongoConnectionString - Connection string do MongoDB
 * @param correlationId - ID de correlação da execução
 * @param databaseName - Nome do banco de dados
 * @param collections - Nomes das collections (opcional)
 * @returns Promise<TraceabilityResponse> - Dados estruturados da execução
 */
export async function getExecutionTraceability(
    mongoConnectionString: string,
    correlationId: string,
    databaseName: string,
    collections?: {
        logs?: string;
        telemetry?: string;
        executions?: string;
    },
): Promise<TraceabilityResponse> {
    const logsCollection = collections?.logs || 'observability_logs_ts';
    const telemetryCollection =
        collections?.telemetry || 'observability_telemetry';
    const executionsCollection = collections?.executions || 'executions';
    const logger = createLogger('traceability');
    let client: MongoClient | null = null;

    try {
        logger.log({
            message: '🔍 Starting traceability search',
            context: 'getExecutionTraceability',

            metadata: {
                correlationId,
                databaseName,
            },
        });

        // Conectar ao MongoDB
        client = new MongoClient(mongoConnectionString);
        await client.connect();

        const db = client.db(databaseName);

        // Buscar dados de todas as collections
        const [logs, telemetry] = await Promise.all([
            db
                .collection(logsCollection)
                .find({ correlationId })
                .sort({ timestamp: 1 })
                .toArray(),
            db
                .collection(telemetryCollection)
                .find({ correlationId })
                .sort({ timestamp: 1 })
                .toArray(),
        ]);

        // Buscar execution tracking se existir
        let executionData: any = {};
        try {
            const executions = await db
                .collection(executionsCollection)
                .find({ correlationId })
                .toArray();
            if (executions.length > 0) {
                executionData = executions[0];
            }
        } catch (error) {
            logger.warn({
                message: 'Execution collection not found or error',
                context: 'getExecutionTraceability',
                error: error as Error,
            });
        }

        // Calcular estatísticas
        const allTimestamps = [
            ...logs.map((log: any) => log.timestamp),
            ...telemetry.map((tel: any) => tel.timestamp),
        ].sort();

        const startTime =
            allTimestamps.length > 0 ? allTimestamps[0] : undefined;
        const endTime =
            allTimestamps.length > 0
                ? allTimestamps[allTimestamps.length - 1]
                : undefined;
        const duration =
            startTime && endTime
                ? endTime.getTime() - startTime.getTime()
                : undefined;

        // Determinar status baseado nos dados
        let status: 'success' | 'error' | 'running' = 'running';
        if (
            executionData.status === 'completed' ||
            telemetry.some((tel: any) => tel.status === 'ok')
        ) {
            status = 'success';
        } else if (telemetry.some((tel: any) => tel.status === 'error')) {
            status = 'error';
        }

        // Criar timeline ordenada
        const timeline = [
            ...logs.map((log: any) => ({
                timestamp: log.timestamp,
                type: 'log' as const,
                component: log.component,
                message: log.message,
                level: log.level,
            })),
            ...telemetry.map((tel: any) => ({
                timestamp: tel.timestamp,
                type: 'telemetry' as const,
                name: tel.name,
                duration: tel.duration,
                phase: tel.phase,
                agentName: tel.agentName,
                toolName: tel.toolName,
            })),
        ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        // Montar resposta
        const response: TraceabilityResponse = {
            correlationId,
            summary: {
                totalLogs: logs.length,
                totalTelemetry: telemetry.length,
                startTime,
                endTime,
                duration,
                status,
            },
            timeline,
            details: {
                logs: logs.map((log) => log as unknown as MongoDBLogItem),
                telemetry: telemetry.map(
                    (tel) => tel as unknown as MongoDBTelemetryItem,
                ),
            },
            execution: {
                executionId: executionData.executionId,
                agentName: executionData.agentName,
                sessionId: executionData.sessionId,
                tenantId: executionData.tenantId,
                input: executionData.input,
                output: executionData.output,
                steps: executionData.steps,
            },
        };

        logger.log({
            message: '✅ Traceability search completed',
            context: 'getExecutionTraceability',

            metadata: {
                correlationId,
                totalItems: timeline.length,
                status,
                duration,
            },
        });

        return response;
    } catch (error) {
        logger.error({
            message: '❌ Error during traceability search',
            context: 'getExecutionTraceability',
            error: error as Error,

            metadata: {
                correlationId,
            },
        });

        // Retornar resposta de erro
        return {
            correlationId,
            summary: {
                totalLogs: 0,
                totalTelemetry: 0,
                status: 'error',
            },
            timeline: [
                {
                    timestamp: new Date(),
                    type: 'log',
                    level: 'error',
                    component: 'traceability',
                    message: `Failed to retrieve traceability: ${(error as Error).message}`,
                },
            ],
            details: {
                logs: [],
                telemetry: [],
            },
            execution: {},
        };
    } finally {
        if (client) {
            await client.close();
        }
    }
}

/**
 * Busca apenas o resumo da execução (mais rápido)
 * @param mongoConnectionString - Connection string do MongoDB
 * @param correlationId - ID de correlação da execução
 * @param databaseName - Nome do banco de dados
 * @param collections - Nomes das collections (opcional)
 * @returns Promise com resumo da execução
 */
export async function getExecutionSummary(
    mongoConnectionString: string,
    correlationId: string,
    databaseName: string,
    collections?: {
        logs?: string;
        telemetry?: string;
    },
): Promise<TraceabilityResponse['summary'] & { correlationId: string }> {
    const logsCollection = collections?.logs || 'observability_logs_ts';
    const telemetryCollection =
        collections?.telemetry || 'observability_telemetry';
    const logger = createLogger('traceability-summary');
    let client: MongoClient | null = null;

    try {
        client = new MongoClient(mongoConnectionString);
        await client.connect();

        const db = client.db(databaseName);

        // Contar documentos em cada collection
        const [totalLogs, totalTelemetry] = await Promise.all([
            db.collection(logsCollection).countDocuments({ correlationId }),
            db
                .collection(telemetryCollection)
                .countDocuments({ correlationId }),
        ]);

        // Buscar primeiro e último timestamp
        const firstDoc = await db
            .collection(telemetryCollection)
            .findOne({ correlationId }, { sort: { timestamp: 1 } });
        const lastDoc = await db
            .collection(telemetryCollection)
            .findOne({ correlationId }, { sort: { timestamp: -1 } });

        const startTime = firstDoc?.timestamp;
        const endTime = lastDoc?.timestamp;
        const duration =
            startTime && endTime
                ? endTime.getTime() - startTime.getTime()
                : undefined;

        // Determinar status
        let status: 'success' | 'error' | 'running' = 'running';

        const hasError = await db
            .collection(telemetryCollection)
            .findOne({ correlationId, status: 'error' });

        if (hasError) {
            status = 'error';
        } else if (totalTelemetry > 0) {
            // Should check for a successful completion span
            status = 'success';
        }

        return {
            correlationId,
            totalLogs,
            totalTelemetry,
            startTime,
            endTime,
            duration,
            status,
        };
    } catch (error) {
        logger.error({
            message: 'Error getting execution summary',
            context: 'getExecutionSummary',
            error: error as Error,

            metadata: {
                correlationId,
            },
        });
        return {
            correlationId,
            totalLogs: 0,
            totalTelemetry: 0,
            status: 'error',
        };
    } finally {
        if (client) {
            await client.close();
        }
    }
}
