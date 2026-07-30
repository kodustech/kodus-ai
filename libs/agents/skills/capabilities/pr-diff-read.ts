import {
    executeDeterministicTool,
    DeterministicFallbackReason,
} from '../runtime/deterministic-tool-executor';
import {
    CapabilityExecutionTrace,
    ToolCaller,
} from '../runtime/skill-runtime.types';
import { asRecord, safeJsonParse } from '../runtime/value-utils';
import { createLogger } from '@libs/core/log/logger';

const PR_DIFF_CAPABILITY = 'pr.diff.read';

const diffLogger = createLogger('skill-pr-diff');

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

    // [diag] Full visibility into the diff fetch: which tool, exactly which
    // org/team/repo/PR we ask for. This is where "Need Pull Request Diff" comes
    // from — the args reveal tenant/PR mismatches at a glance.
    diffLogger.log({
        message: '[skill-pr-diff] fetchPullRequestDiff: requesting diff',
        context: 'pr-diff-read',
        metadata: {
            toolName: toolName ?? null,
            hasParams: !!params,
            organizationId: params?.organizationId ?? null,
            teamId: params?.teamId ?? null,
            repositoryId: params?.repositoryId ?? null,
            repositoryName: params?.repositoryName ?? null,
            pullRequestNumber: params?.pullRequestNumber ?? null,
        },
    });

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
        callTool: async (selectedTool, args) => {
            const raw = await toolCaller.callTool(selectedTool, args);
            // [obs] Lightweight shape signal (NOT the full diff): did a result
            // come back, and how big — enough to spot an empty/error response
            // without dumping the multi-KB patch into the logs.
            const rawRecord = (raw ?? {}) as { result?: unknown };
            diffLogger.log({
                message: '[skill-pr-diff] tool responded',
                context: 'pr-diff-read',
                metadata: {
                    selectedTool,
                    hasResult: rawRecord.result !== undefined,
                    resultSize: rawRecord.result
                        ? JSON.stringify(rawRecord.result).length
                        : 0,
                },
            });
            return raw;
        },
        validate: () => (params ? undefined : 'precondition_failed'),
        extract: extractDiffFromToolResult,
        fallback: '',
        onError: 'fallback',
        onFallback: (reason) => {
            fallbackReason = reason;
        },
    });

    const diffLength = typeof diff === 'string' ? diff.length : 0;
    const success = typeof diff === 'string' && diff.length > 0;

    // [diag] Final outcome: the fallbackReason (empty_result / tool_error /
    // tool_not_registered / precondition_failed) + the resolved diff size.
    diffLogger.log({
        message: '[skill-pr-diff] fetchPullRequestDiff: outcome',
        context: 'pr-diff-read',
        metadata: {
            success,
            diffLength,
            fallbackReason: fallbackReason ?? null,
            pullRequestNumber: params?.pullRequestNumber ?? null,
            organizationId: params?.organizationId ?? null,
        },
    });

    if (fallbackReason) {
        const trace = buildFallbackTrace(base, fallbackReason, startedAt);

        return { diff: '', traces: [trace] };
    }

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

    // executeDeterministicTool already unwraps one level (it passes
    // `toolResult.result`), so `payload` IS the tool's `result` object —
    // typically the MCP envelope { content: [{ type:'text', text:'{...}' }] }.
    // Older callers passed the full { result: {...} }. Be robust to BOTH: try
    // the node itself first, then a nested `.result`. (The off-by-one here was
    // exactly what made KODUS_GET_PULL_REQUEST_DIFF return an empty diff.)
    const candidates = [root, asRecord(root.result)];

    for (const node of candidates) {
        const directData = node.data;
        if (typeof directData === 'string' && directData.length > 0) {
            return directData;
        }

        const structuredData = asRecord(node.structuredContent).data;
        if (typeof structuredData === 'string' && structuredData.length > 0) {
            return structuredData;
        }

        const content = Array.isArray(node.content) ? node.content : [];
        for (const item of content) {
            const record = asRecord(item);
            if (record.type !== 'text' || typeof record.text !== 'string') {
                continue;
            }
            const parsed = safeJsonParse<Record<string, unknown>>(
                record.text,
                {},
            );
            if (typeof parsed.data === 'string') {
                return parsed.data;
            }
        }
    }

    return '';
}
