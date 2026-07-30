import { ExecutionCycle, ExecutionStep } from './types';
import { createLogger } from '@libs/core/log/logger';
import { IdGenerator } from '@libs/core/utils/id-generator';

/**
 * Centralized execution cycle tracker for complete agent lifecycle monitoring
 */
export class ExecutionTracker {
    private static instance: ExecutionTracker;
    private cycles: Map<string, ExecutionCycle> = new Map();
    private logger = createLogger('execution-tracker');
    private maxCycles = 1000; // Prevent memory leaks

    private constructor() {}

    static getInstance(): ExecutionTracker {
        if (!ExecutionTracker.instance) {
            ExecutionTracker.instance = new ExecutionTracker();
        }
        return ExecutionTracker.instance;
    }

    /**
     * Start tracking a new execution cycle
     */
    startExecution(
        agentName: string,
        correlationId: string,
        metadata: Partial<ExecutionCycle['metadata']> = {},
        input?: unknown,
    ): string {
        const executionId = IdGenerator.executionId();

        // Prevent memory leaks by limiting active cycles
        if (this.cycles.size >= this.maxCycles) {
            this.logger.warn({
                message:
                    'Maximum execution cycles reached, cleaning up old cycles',
                context: this.constructor.name,
            });
            this.cleanupOldCycles();
        }

        const cycle: ExecutionCycle = {
            executionId,
            agentName,
            correlationId,
            startTime: Date.now(),
            steps: [],
            status: 'running',
            metadata: {
                tenantId: metadata.tenantId,
                sessionId: metadata.sessionId,
                threadId: metadata.threadId,
                userId: metadata.userId,
            },
            ...(input ? { input } : {}),
        };

        this.cycles.set(executionId, cycle);

        // Add start step
        this.addStep(executionId, 'start', 'execution-tracker', {
            agentName,
            correlationId,
            input: input ? this.truncateValue(input) : undefined,
        });

        this.logger.debug({
            message: 'Execution cycle started',
            context: this.constructor.name,

            metadata: {
                executionId,
                agentName,
                correlationId,
            },
        });

        return executionId;
    }

    /**
     * Add a step to an execution cycle
     */
    addStep(
        executionId: string,
        type: ExecutionStep['type'],
        component: string,
        data: Record<string, unknown>,
        duration?: number,
    ): void {
        const cycle = this.cycles.get(executionId);
        if (!cycle) {
            this.logger.warn({
                message: 'Attempted to add step to unknown execution',
                context: this.constructor.name,

                metadata: {
                    executionId,
                    type,
                    component,
                },
            });
            return;
        }

        const step: ExecutionStep = {
            id: IdGenerator.generateSpanId(),
            timestamp: Date.now(),
            type,
            component,
            data: this.truncateData(data),
            ...(duration && { duration }),
        };

        cycle.steps.push(step);

        // Keep only last 50 steps to prevent memory bloat
        if (cycle.steps.length > 50) {
            cycle.steps.shift();
        }

        this.logger.debug({
            message: 'Execution step added',
            context: this.constructor.name,

            metadata: {
                executionId,
                type,
                component,
                stepCount: cycle.steps.length,
            },
        });
    }

    /**
     * Complete an execution cycle successfully
     */
    completeExecution(executionId: string, output?: unknown): void {
        const cycle = this.cycles.get(executionId);
        if (!cycle) {
            this.logger.warn({
                message: 'Attempted to complete unknown execution',
                context: this.constructor.name,

                metadata: {
                    executionId,
                },
            });
            return;
        }

        cycle.endTime = Date.now();
        cycle.totalDuration = cycle.endTime - cycle.startTime;
        cycle.status = 'completed';
        if (output !== undefined) {
            cycle.output = output;
        }

        // Add finish step
        this.addStep(executionId, 'finish', 'execution-tracker', {
            output: output ? this.truncateValue(output) : undefined,
            totalDuration: cycle.totalDuration,
            stepCount: cycle.steps.length,
        });

        this.logger.log({
            message: 'Execution cycle completed',
            context: this.constructor.name,

            metadata: {
                executionId,
                agentName: cycle.agentName,
                totalDuration: cycle.totalDuration,
                stepCount: cycle.steps.length,
            },
        });

        // Clean up after 5 minutes to prevent memory leaks
        setTimeout(
            () => {
                this.cycles.delete(executionId);
            },
            5 * 60 * 1000,
        );
    }

    /**
     * Mark execution as failed
     */
    failExecution(executionId: string, error: Error): void {
        const cycle = this.cycles.get(executionId);
        if (!cycle) {
            this.logger.warn({
                message: 'Attempted to fail unknown execution',
                context: this.constructor.name,

                metadata: {
                    executionId,
                },
            });
            return;
        }

        cycle.endTime = Date.now();
        cycle.totalDuration = cycle.endTime - cycle.startTime;
        cycle.status = 'error';
        cycle.error = error;

        // Add error step
        this.addStep(executionId, 'error', 'execution-tracker', {
            errorName: error.name,
            errorMessage: error.message,
            totalDuration: cycle.totalDuration,
        });

        this.logger.error({
            message: 'Execution cycle failed',
            context: this.constructor.name,
            error: error,

            metadata: {
                executionId,
                agentName: cycle.agentName,
                totalDuration: cycle.totalDuration,
            },
        });

        // Clean up after 10 minutes for failed executions
        setTimeout(
            () => {
                this.cycles.delete(executionId);
            },
            10 * 60 * 1000,
        );
    }

    /**
     * Get current execution cycle data
     */
    getExecution(executionId: string): ExecutionCycle | undefined {
        return this.cycles.get(executionId);
    }

    /**
     * Get all active executions
     */
    getActiveExecutions(): ExecutionCycle[] {
        return Array.from(this.cycles.values()).filter(
            (cycle) => cycle.status === 'running',
        );
    }

    /**
     * Get execution summary for monitoring
     */
    getExecutionSummary(executionId: string): {
        executionId: string;
        agentName: string;
        status: string;
        duration: number;
        stepCount: number;
        hasError: boolean;
    } | null {
        const cycle = this.cycles.get(executionId);
        if (!cycle) return null;

        return {
            executionId: cycle.executionId,
            agentName: cycle.agentName,
            status: cycle.status,
            duration: cycle.totalDuration || Date.now() - cycle.startTime,
            stepCount: cycle.steps.length,
            hasError: cycle.status === 'error',
        };
    }

    /**
     * Clear all execution cycles (useful for shutdown or testing)
     */
    clear(): void {
        this.cycles.clear();
        // Removed log: 'All execution cycles cleared' - internal system message, no business value
    }

    /**
     * Clean up old completed cycles to prevent memory leaks
     */
    private cleanupOldCycles(): void {
        const now = Date.now();
        const toDelete: string[] = [];

        for (const [executionId, cycle] of this.cycles.entries()) {
            // Delete cycles older than 30 minutes
            if (now - cycle.startTime > 30 * 60 * 1000) {
                toDelete.push(executionId);
            }
        }

        for (const executionId of toDelete) {
            this.cycles.delete(executionId);
        }

        this.logger.debug({
            message: 'Cleaned up old execution cycles',
            context: this.constructor.name,

            metadata: {
                deleted: toDelete.length,
                remaining: this.cycles.size,
            },
        });
    }

    /**
     * Truncate large values to prevent memory issues
     */
    private truncateValue(value: unknown): string {
        let str: string;
        if (typeof value === 'string') {
            str = value;
        } else {
            try {
                const jsonStr = JSON.stringify(value);
                str = jsonStr ?? '[Unable to stringify]';
            } catch {
                str = `[Serialization error: ${String(value)}]`;
            }
        }

        return str.length > 500 ? str.substring(0, 500) + '...' : str;
    }

    /**
     * Truncate data object values
     */
    private truncateData(
        data: Record<string, unknown>,
    ): Record<string, unknown> {
        const truncated: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(data)) {
            truncated[key] = this.truncateValue(value);
        }

        return truncated;
    }
}

// Export singleton instance
export const executionTracker = ExecutionTracker.getInstance();

// Helper functions for easy integration
export function startExecutionTracking(
    agentName: string,
    correlationId: string,
    metadata?: Partial<ExecutionCycle['metadata']>,
    input?: unknown,
): string {
    return executionTracker.startExecution(
        agentName,
        correlationId,
        metadata,
        input,
    );
}

export function addExecutionStep(
    executionId: string,
    type: ExecutionStep['type'],
    component: string,
    data: Record<string, unknown>,
    duration?: number,
): void {
    executionTracker.addStep(executionId, type, component, data, duration);
}

export function completeExecutionTracking(
    executionId: string,
    output?: unknown,
): void {
    executionTracker.completeExecution(executionId, output);
}

export function failExecutionTracking(executionId: string, error: Error): void {
    executionTracker.failExecution(executionId, error);
}

export function getExecutionTracking(
    executionId: string,
): ExecutionCycle | undefined {
    return executionTracker.getExecution(executionId);
}
