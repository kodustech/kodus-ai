import {
    executeDeterministicTool,
    DeterministicFallbackReason,
} from '../runtime/deterministic-tool-executor';
import {
    CapabilityExecutionTrace,
    ToolCaller,
} from '../runtime/skill-runtime.types';
import { asRecord, safeJsonParse } from '../runtime/value-utils';

const PR_DIFF_CAPABILITY = 'pr.diff.read';

export interface PrDiffReadParams {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName?: string;
    pullRequestNumber: number;
}

export interface PrDiffReadResult {
    diff: string;
    traces: CapabilityExecutionTrace[];
}

interface CapabilityExecutionContext {
    skillName: string;
    organizationId: string;
    teamId: string;
    provider?: string;
}

export async function fetchPullRequestDiff(
    toolCaller: ToolCaller,
    toolName: string | undefined,
    params: PrDiffReadParams | undefined,
    ctx: CapabilityExecutionContext,
): Promise<PrDiffReadResult> {
    const startedAt = Date.now();
    const base = createBaseTrace(ctx, toolName);
    let fallbackReason: DeterministicFallbackReason | undefined;

    const diff = await executeDeterministicTool({
        toolName,
        args: params
            ? {
                  organizationId: params.organizationId,
                  teamId: params.teamId,
                  repositoryId: params.repositoryId,
                  repositoryName: params.repositoryName,
                  prNumber: params.pullRequestNumber,
              }
            : {},
        callTool: (selectedTool, args) =>
            toolCaller.callTool(selectedTool, args),
        validate: () => (params ? undefined : 'precondition_failed'),
        extract: extractDiffFromToolResult,
        fallback: '',
        onError: 'fallback',
        onFallback: (reason) => {
            fallbackReason = reason;
        },
    });

    if (fallbackReason) {
        const trace = buildFallbackTrace(base, fallbackReason, startedAt);

        return { diff: '', traces: [trace] };
    }

    const success = typeof diff === 'string' && diff.length > 0;
    const trace = buildResultTrace(base, success, startedAt);

    return {
        diff: success ? diff : '',
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
        capability: PR_DIFF_CAPABILITY,
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

function extractDiffFromToolResult(payload: unknown): string {
    const root = asRecord(payload);
    const nestedResult = asRecord(root.result);
    const structuredContent = asRecord(nestedResult.structuredContent);

    const directData = root.data;
    if (typeof directData === 'string') {
        return directData;
    }

    const nestedData = nestedResult.data;
    if (typeof nestedData === 'string') {
        return nestedData;
    }

    const structuredData = structuredContent.data;
    if (typeof structuredData === 'string') {
        return structuredData;
    }

    const content = Array.isArray(nestedResult.content)
        ? nestedResult.content
        : [];
    for (const item of content) {
        const record = asRecord(item);
        if (record.type !== 'text' || typeof record.text !== 'string') {
            continue;
        }

        const parsed = safeJsonParse<Record<string, unknown>>(record.text, {});
        if (typeof parsed.data === 'string') {
            return parsed.data;
        }
    }

    return '';
}
