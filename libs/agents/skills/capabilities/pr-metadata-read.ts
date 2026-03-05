import {
    executeDeterministicTool,
    DeterministicFallbackReason,
} from '../runtime/deterministic-tool-executor';
import {
    CapabilityExecutionTrace,
    ToolCaller,
} from '../runtime/skill-runtime.types';
import { asRecord } from '../runtime/value-utils';

const PR_METADATA_CAPABILITY = 'pr.metadata.read';

export interface PrMetadataReadParams {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName?: string;
    pullRequestNumber: number;
}

export interface PrMetadataReadResult {
    body: string | undefined;
    traces: CapabilityExecutionTrace[];
}

interface CapabilityExecutionContext {
    skillName: string;
    organizationId: string;
    teamId: string;
    provider?: string;
}

export async function fetchPullRequestMetadata(
    toolCaller: ToolCaller,
    toolName: string | undefined,
    params: PrMetadataReadParams | undefined,
    ctx: CapabilityExecutionContext,
): Promise<PrMetadataReadResult> {
    const startedAt = Date.now();
    const base = createBaseTrace(ctx, toolName);
    let fallbackReason: DeterministicFallbackReason | undefined;

    const body = await executeDeterministicTool({
        toolName,
        args: params
            ? {
                  organizationId: params.organizationId,
                  teamId: params.teamId,
                  repository: {
                      id: params.repositoryId,
                      name: params.repositoryName ?? params.repositoryId,
                  },
                  prNumber: params.pullRequestNumber,
              }
            : {},
        callTool: (selectedTool, args) =>
            toolCaller.callTool(selectedTool, args),
        validate: () => (params ? undefined : 'precondition_failed'),
        extract: extractPrBodyFromToolResult,
        fallback: undefined,
        onError: 'fallback',
        onFallback: (reason) => {
            fallbackReason = reason;
        },
    });

    if (fallbackReason) {
        const trace = buildFallbackTrace(base, fallbackReason, startedAt);

        return { body: undefined, traces: [trace] };
    }

    const success = typeof body === 'string' && body.length > 0;
    const trace = buildResultTrace(base, success, startedAt);

    return {
        body: success ? body : undefined,
        traces: [trace],
    };
}

function createBaseTrace(
    ctx: CapabilityExecutionContext,
    toolName: string | undefined,
): Omit<CapabilityExecutionTrace, 'status' | 'latencyMs' | 'reason'> {
    return {
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        skillName: ctx.skillName,
        capability: PR_METADATA_CAPABILITY,
        provider: ctx.provider ?? 'external',
        mode: 'deterministic',
        toolName,
        occurredAt: new Date().toISOString(),
    };
}

function buildFallbackTrace(
    base: Omit<CapabilityExecutionTrace, 'status' | 'latencyMs' | 'reason'>,
    reason: DeterministicFallbackReason,
    startedAt: number,
): CapabilityExecutionTrace {
    return {
        ...base,
        status:
            reason === 'tool_unavailable' || reason === 'precondition_failed'
                ? 'skipped'
                : 'failed',
        reason,
        latencyMs: Date.now() - startedAt,
    };
}

function buildResultTrace(
    base: Omit<CapabilityExecutionTrace, 'status' | 'latencyMs' | 'reason'>,
    success: boolean,
    startedAt: number,
): CapabilityExecutionTrace {
    return success
        ? {
              ...base,
              status: 'success',
              latencyMs: Date.now() - startedAt,
          }
        : {
              ...base,
              status: 'failed',
              reason: 'empty_result',
              latencyMs: Date.now() - startedAt,
          };
}

function extractPrBodyFromToolResult(payload: unknown): string | undefined {
    const root = asRecord(payload);
    const nestedResult = asRecord(root.result);

    const directData = asRecord(root.data);
    const nestedData = asRecord(nestedResult.data);

    if (typeof directData.body === 'string') {
        return directData.body;
    }
    if (typeof nestedData.body === 'string') {
        return nestedData.body;
    }
    if (typeof directData.message === 'string') {
        return directData.message;
    }
    if (typeof nestedData.message === 'string') {
        return nestedData.message;
    }

    return undefined;
}
