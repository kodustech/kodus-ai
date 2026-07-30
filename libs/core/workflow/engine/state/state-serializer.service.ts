import { promisify } from 'util';
import * as zlib from 'zlib';

import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { PipelineContext } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export type SerializationStrategy = 'full' | 'delta' | 'minimal' | 'compressed';

export interface SerializationOptions {
    strategy: SerializationStrategy;
    previousState?: PipelineContext;
}

@Injectable()
export class StateSerializerService {
    private readonly logger = createLogger(StateSerializerService.name);

    /**
     * Serializes state with configurable strategy
     */
    async serialize<TContext extends PipelineContext>(
        context: TContext,
        options: SerializationOptions = { strategy: 'full' },
    ): Promise<Record<string, unknown>> {
        switch (options.strategy) {
            case 'delta':
                return this.serializeDelta(
                    context,
                    options.previousState as TContext,
                );
            case 'minimal':
                return this.serializeMinimal(context);
            case 'compressed':
                return await this.serializeCompressed(context);
            case 'full':
            default:
                return this.serializeFull(context);
        }
    }

    /**
     * Deserializes state (auto-detects if compressed)
     */
    async deserialize<TContext extends PipelineContext>(
        data: Record<string, unknown>,
    ): Promise<TContext> {
        // Check if compressed
        if (data.compressed && typeof data.data === 'string') {
            return await this.deserializeCompressed<TContext>(data);
        }

        // Deserialize as normal JSON
        return data as unknown as TContext;
    }

    /**
     * Full serialization (current - default)
     */
    private serializeFull<TContext extends PipelineContext>(
        context: TContext,
    ): Record<string, unknown> {
        return JSON.parse(JSON.stringify(context));
    }

    /**
     * Incremental serialization (changes only)
     * Compares with previous state and saves only significant differences
     */
    private serializeDelta<TContext extends PipelineContext>(
        currentState: TContext,
        previousState?: TContext,
    ): Record<string, unknown> {
        if (!previousState) {
            // First checkpoint - save everything
            return this.serializeFull(currentState);
        }

        const delta: Record<string, unknown> = {
            workflowJobId: (currentState as any).workflowJobId,
            currentStage: (currentState as any).currentStage,
            correlationId: (currentState as any).correlationId,
            automationExecutionId: (currentState as any).automationExecutionId,
            updatedAt: Date.now(),
            _strategy: 'delta',
        };

        // Compare and add only significant changes
        // TODO: Make this list configurable or dynamic
        const significantFields = [
            'validSuggestions',
            'discardedSuggestions',
            'fileMetadata',
            'prAnalysisResults',
            'changedFiles',
            'statusInfo',
            'tasks',
            'initialCommentData',
        ];

        for (const field of significantFields) {
            const currentValue = (currentState as any)[field];
            const previousValue = (previousState as any)[field];

            if (
                currentValue !== undefined &&
                JSON.stringify(currentValue) !== JSON.stringify(previousValue)
            ) {
                delta[field] = currentValue;
            }
        }

        // Always include essential metadata if it exists
        if ((currentState as any).organizationAndTeamData) {
            delta.organizationAndTeamData = {
                organizationId: (currentState as any).organizationAndTeamData
                    ?.organizationId,
                teamId: (currentState as any).organizationAndTeamData?.teamId,
            };
        }

        if ((currentState as any).repository) {
            delta.repository = {
                id: (currentState as any).repository?.id,
                name: (currentState as any).repository?.name,
            };
        }

        if ((currentState as any).pullRequest) {
            delta.pullRequest = {
                number: (currentState as any).pullRequest?.number,
            };
        }

        return delta;
    }

    /**
     * Minimal serialization (only IDs and essential references)
     * Useful for intermediate checkpoints where full state is not needed
     */
    private serializeMinimal<TContext extends PipelineContext>(
        context: TContext,
    ): Record<string, unknown> {
        const minimal: Record<string, unknown> = {
            workflowJobId: (context as any).workflowJobId,
            currentStage: (context as any).currentStage,
            correlationId: (context as any).correlationId,
            automationExecutionId: (context as any).automationExecutionId,
            _strategy: 'minimal',
        };

        // Add domain specific fields if they exist
        if ((context as any).organizationAndTeamData) {
            minimal.organizationId = (
                context as any
            ).organizationAndTeamData?.organizationId;
            minimal.teamId = (context as any).organizationAndTeamData?.teamId;
        }

        if ((context as any).repository) {
            minimal.repositoryId = (context as any).repository?.id;
        }

        if ((context as any).pullRequest) {
            minimal.pullRequestNumber = (context as any).pullRequest?.number;
        }

        return minimal;
    }

    /**
     * Compressed serialization
     * Compresses the full state before saving
     */
    private async serializeCompressed<TContext extends PipelineContext>(
        context: TContext,
    ): Promise<Record<string, unknown>> {
        const serialized = JSON.stringify(context);
        const compressed = await gzip(Buffer.from(serialized));

        return {
            compressed: true,
            _strategy: 'compressed',
            data: compressed.toString('base64'),
            size: serialized.length, // Original size for reference
            compressedSize: compressed.length, // Compressed size
        };
    }

    /**
     * Deserializes compressed state
     */
    private async deserializeCompressed<TContext extends PipelineContext>(
        data: Record<string, unknown>,
    ): Promise<TContext> {
        if (!data.compressed || typeof data.data !== 'string') {
            throw new Error('Invalid compressed state format');
        }

        try {
            const decompressed = await gunzip(Buffer.from(data.data, 'base64'));
            return JSON.parse(decompressed.toString()) as TContext;
        } catch (error) {
            this.logger.error({
                message: 'Failed to decompress pipeline state',
                context: StateSerializerService.name,
                error: error instanceof Error ? error : undefined,
            });
            throw error;
        }
    }

    /**
     * Applies delta to previous state to reconstruct full state
     */
    applyDelta<TContext extends PipelineContext>(
        baseState: TContext,
        delta: Record<string, unknown>,
    ): TContext {
        if (delta._strategy !== 'delta') {
            return delta as unknown as TContext;
        }

        // Apply delta changes to base state
        const reconstructed = { ...baseState };

        for (const [key, value] of Object.entries(delta)) {
            if (key !== '_strategy' && key !== 'updatedAt') {
                (reconstructed as any)[key] = value;
            }
        }

        return reconstructed;
    }
}
