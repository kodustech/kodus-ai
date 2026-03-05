import { Injectable, Logger, Optional } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';

import { BoundedMap } from './bounded-map';
import {
    CapabilityExecutionTrace,
    CapabilityStrategyScope,
} from './skill-runtime.types';

interface ToolStrategyStats {
    successCount: number;
    failedCount: number;
    skippedCount: number;
    totalLatencyMs: number;
    lastUsedAt: string;
}

interface CapabilityStrategyState {
    scope: CapabilityStrategyScope;
    preferredTool?: string;
    promoted: boolean;
    toolStats: Record<string, ToolStrategyStats>;
    updatedAt: string;
}

const STRATEGY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMORY_STALENESS_MS = 60_000;
const MIN_PROMOTION_SUCCESSES = 3;
const MIN_PROMOTION_SUCCESS_RATE = 0.7;

interface MemoryEntry {
    state: CapabilityStrategyState;
    cachedAt: number;
}

@Injectable()
export class CapabilityStrategyService {
    private readonly logger = new Logger(CapabilityStrategyService.name);
    private readonly memoryStore = new BoundedMap<string, MemoryEntry>(512);

    constructor(@Optional() private readonly cacheService?: CacheService) {}

    async getPreferredTool(
        scope: CapabilityStrategyScope,
        candidateTools: string[],
    ): Promise<string | undefined> {
        if (!candidateTools.length) {
            return undefined;
        }

        const state = await this.readState(scope);
        if (!state) {
            return undefined;
        }

        if (
            state.promoted &&
            state.preferredTool &&
            candidateTools.includes(state.preferredTool)
        ) {
            return state.preferredTool;
        }

        const sortedCandidates = candidateTools
            .map((tool) => ({
                tool,
                score: this.computeToolScore(state.toolStats[tool]),
            }))
            .sort((a, b) => b.score - a.score);

        return sortedCandidates[0]?.score > 0
            ? sortedCandidates[0].tool
            : undefined;
    }

    async recordExecution(trace: CapabilityExecutionTrace): Promise<void> {
        if (!trace.toolName) {
            return;
        }

        const scope: CapabilityStrategyScope = {
            organizationId: trace.organizationId,
            teamId: trace.teamId,
            skillName: trace.skillName,
            capability: trace.capability,
            provider: trace.provider,
        };

        const state =
            (await this.readState(scope)) ??
            ({
                scope,
                promoted: false,
                toolStats: {},
                updatedAt: trace.occurredAt,
            } as CapabilityStrategyState);

        const current = state.toolStats[trace.toolName] ?? {
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
            totalLatencyMs: 0,
            lastUsedAt: trace.occurredAt,
        };

        if (trace.status === 'success') {
            current.successCount += 1;
        } else if (trace.status === 'failed') {
            current.failedCount += 1;
        } else {
            current.skippedCount += 1;
        }

        current.totalLatencyMs += Math.max(0, trace.latencyMs);
        current.lastUsedAt = trace.occurredAt;
        state.toolStats[trace.toolName] = current;
        state.updatedAt = trace.occurredAt;

        this.promotePreferredTool(state);
        await this.writeState(state);
    }

    private promotePreferredTool(state: CapabilityStrategyState): void {
        const sortedTools = Object.entries(state.toolStats)
            .map(([toolName, stats]) => ({ toolName, stats }))
            .sort(
                (a, b) =>
                    this.computeToolScore(b.stats) -
                    this.computeToolScore(a.stats),
            );

        const top = sortedTools[0];
        if (!top) {
            state.promoted = false;
            state.preferredTool = undefined;
            return;
        }

        const attempts = top.stats.successCount + top.stats.failedCount;
        const successRate =
            attempts > 0 ? top.stats.successCount / attempts : 0;
        const canPromote =
            top.stats.successCount >= MIN_PROMOTION_SUCCESSES &&
            successRate >= MIN_PROMOTION_SUCCESS_RATE;

        state.promoted = canPromote;
        state.preferredTool = canPromote ? top.toolName : undefined;
    }

    private computeToolScore(stats: ToolStrategyStats | undefined): number {
        if (!stats) {
            return 0;
        }

        return stats.successCount * 2 - stats.failedCount - stats.skippedCount;
    }

    private buildKey(scope: CapabilityStrategyScope): string {
        return [
            'skill-capability-strategy',
            scope.organizationId,
            scope.teamId,
            scope.skillName,
            scope.capability,
            scope.provider,
        ].join(':');
    }

    private async readState(
        scope: CapabilityStrategyScope,
    ): Promise<CapabilityStrategyState | undefined> {
        const key = this.buildKey(scope);
        const fromMemory = this.memoryStore.get(key);
        const isStale =
            fromMemory &&
            Date.now() - fromMemory.cachedAt > MEMORY_STALENESS_MS;

        if (fromMemory && !isStale) {
            return fromMemory.state;
        }

        if (!this.cacheService) {
            return fromMemory?.state;
        }

        try {
            const fromCache =
                await this.cacheService.getFromCache<CapabilityStrategyState>(
                    key,
                );
            if (fromCache) {
                this.memoryStore.set(key, {
                    state: fromCache,
                    cachedAt: Date.now(),
                });
                return fromCache;
            }
            return fromMemory?.state;
        } catch (error) {
            this.logger.warn(
                `Failed to read capability strategy from cache. key=${key}, error=${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return fromMemory?.state;
        }
    }

    private async writeState(state: CapabilityStrategyState): Promise<void> {
        const key = this.buildKey(state.scope);
        this.memoryStore.set(key, { state, cachedAt: Date.now() });

        if (!this.cacheService) {
            return;
        }

        try {
            await this.cacheService.addToCache(
                key,
                state,
                STRATEGY_CACHE_TTL_MS,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to persist capability strategy in cache. key=${key}, error=${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
