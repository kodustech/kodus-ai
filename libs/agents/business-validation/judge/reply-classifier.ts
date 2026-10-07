import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import type { NormalizedModel } from '@libs/llm/byok-config';

import { asRecord } from '../value-utils';

const RESULT_TOOL = 'submitReplyIntent';

/** One open finding the reply may be about, as the classifier sees it. */
export interface OpenFinding {
    /** Index in the list shown to the classifier. */
    index: number;
    taskId: string;
    kind: 'requirement' | 'not_in_task';
    text: string;
    state: string;
}

export type ReplyIntent =
    | {
          intent: 'accept';
          findings: number[];
          /** Where the work went, e.g. another task id. */
          movedTo?: string;
          reason?: string;
      }
    | {
          intent: 'dispute';
          findings: number[];
          /** Files the author says cover it. */
          files: string[];
          claim: string;
      }
    | { intent: 'other' };

const SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        intent: {
            type: 'string',
            enum: ['accept', 'dispute', 'other'],
            description:
                'accept: the writer waives findings (out of scope, moved to another task, will not do). dispute: the writer says a finding is wrong because the code already does it. other: anything else, including questions.',
        },
        findings: {
            type: 'array',
            items: { type: 'number' },
            description: 'Indexes of the findings the reply is about.',
        },
        movedTo: {
            type: 'string',
            description: 'For accept: the task id the work moved to, if named.',
        },
        reason: {
            type: 'string',
            description:
                'For accept: why, in a few words, in the language of the reply.',
        },
        files: {
            type: 'array',
            items: { type: 'string' },
            description: 'For dispute: the files or symbols the writer cites.',
        },
        claim: {
            type: 'string',
            description: 'For dispute: what the writer says, in one sentence.',
        },
    },
    required: ['intent'],
};

/**
 * Reads a reply to the Business Logic comment: does it waive a finding,
 * dispute one, or neither (UC-37, UC-38)? Neither goes to the regular
 * conversation, so a question is never mistaken for a decision.
 */
export async function classifyReply(
    model: NormalizedModel | undefined,
    telemetry: { organizationId?: string; teamId?: string },
    message: string,
    findings: OpenFinding[],
): Promise<ReplyIntent> {
    let payload: unknown;
    const tool = {
        name: RESULT_TOOL,
        description: 'Submit what the reply means. Call it exactly once.',
        inputSchema: SCHEMA,
        execute: async (input: unknown) => {
            payload = input;
            return { output: 'recorded' };
        },
    };
    const spec: AgentSpec = {
        id: 'business-rules-reply-classifier',
        agentName: 'BusinessRulesValidation',
        phase: 'replyClassifier',
        runName: 'replyClassifier',
        spanName: 'BusinessRulesValidation::replyClassifier',
        systemPrompt: [
            'A pull request has a comment listing where it falls short of its task. Someone replied to it.',
            'Decide whether the reply waives findings (accept), says a finding is wrong because the code already covers it (dispute), or neither (other).',
            'Only pick accept or dispute when the reply clearly does that for specific findings. A question, a thank-you or a plan to fix it is other.',
        ].join('\n'),
        tools: new InMemoryToolRegistry([tool]),
        resultToolName: RESULT_TOOL,
        policies: [],
        maxSteps: 1,
        maxOutputTokens: 400,
    };
    const { ctx, cleanup } = createAgentRunContext({
        runId: 'business-rules:reply',
        timeoutMs: 30_000,
    });
    try {
        await new AiSdkAgentRunner(model, {
            organizationId: telemetry.organizationId,
            provider: model?.provider,
        }).run(
            spec,
            {
                prompt: [
                    'FINDINGS:',
                    ...findings.map(
                        (f) =>
                            `${f.index}. [${f.taskId}] ${f.kind === 'not_in_task' ? 'NOT IN TASK' : f.state.toUpperCase()}: ${f.text}`,
                    ),
                    '',
                    'REPLY:',
                    message,
                ].join('\n'),
                telemetryMetadata: { ...telemetry, provider: model?.provider },
            },
            ctx,
        );
    } finally {
        cleanup();
    }
    return parseReplyIntent(payload, findings);
}

export function parseReplyIntent(
    payload: unknown,
    findings: OpenFinding[],
): ReplyIntent {
    const record = asRecord(payload);
    const indexes = Array.isArray(record.findings)
        ? record.findings
              .map(Number)
              .filter((i) => findings.some((f) => f.index === i))
        : [];
    const text = (v: unknown) =>
        typeof v === 'string' && v.trim() ? v.trim() : undefined;
    if (record.intent === 'accept' && indexes.length) {
        return {
            intent: 'accept',
            findings: indexes,
            ...(text(record.movedTo) ? { movedTo: text(record.movedTo) } : {}),
            ...(text(record.reason) ? { reason: text(record.reason) } : {}),
        };
    }
    if (record.intent === 'dispute' && indexes.length) {
        return {
            intent: 'dispute',
            findings: indexes,
            files: Array.isArray(record.files)
                ? record.files.filter((f): f is string => typeof f === 'string')
                : [],
            claim: text(record.claim) ?? '',
        };
    }
    return { intent: 'other' };
}
