/**
 * The independent check every finding takes before it is reported: a fresh
 * agent, on the scan's model and the lens's own tools, reads whether the code
 * is reached, what stops it anywhere in the repository and where it runs,
 * then keeps or refutes it and sets its severity from what it read. The lens
 * already verified the finding inside its own reading; this one starts from
 * the claim alone, so a safeguard in another file, a handler nothing
 * registers or a script only developers run is read before the finding ships.
 *
 * Fail-open: a run that errors or ends without a verdict keeps the finding as
 * the lens reported it. A missed vulnerability costs more than a kept one.
 */
import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { ForceTextFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-text-finalize.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { recoverVerdictObject } from '@libs/agent-harness/infrastructure/verify/llm-verdict';
import { finderRunEnvironment } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
import type {
    AgentLoopInput,
    AgentLoopSecrets,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import { extractLastJsonObjectWith } from '@libs/llm/structured-output-repair';

import type { ScanFinding } from '../domain/security-scan.types';

const logger = createLogger('SecurityScanVerifier');

export const SCAN_VERIFY_TOOL = 'submitVerdict' as const;
const VERIFY_MAX_STEPS = 14;

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

const SCAN_VERDICT_SCHEMA: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        keep: { type: 'boolean' },
        severity: { type: 'string', enum: [...SEVERITIES] },
        assumption: { type: 'string' },
        rationale: { type: 'string' },
    },
    required: ['keep', 'severity', 'assumption', 'rationale'],
};

export interface ScanVerdict {
    keep: boolean;
    /** Unset when the verifier did not judge it (its run failed). */
    severity?: ScanFinding['severity'];
    assumption?: string;
    rationale: string;
    /** False when no verdict was read: the finding is kept as reported. */
    judged: boolean;
}

export interface ScanVerifyRequest {
    /** The lens's input for the finding's unit and class: same model, tools and telemetry. */
    lensInput: AgentLoopInput;
    secrets: AgentLoopSecrets;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
}

export type ScanVerifier = (request: ScanVerifyRequest) => Promise<ScanVerdict>;

export const verifyScanFinding: ScanVerifier = async (request) => {
    const { lensInput, secrets } = request;
    const env = finderRunEnvironment(lensInput, secrets);
    const spec: AgentSpec = {
        id: 'security-scan-verifier',
        runName: `${lensInput.usageRunName ?? 'security-scan'}-verify`,
        agentName: `${lensInput.agentName ?? 'security-scan'}-verify`,
        phase: 'verify',
        systemPrompt: request.systemPrompt,
        tools: new InMemoryToolRegistry([
            ...env.tools.list(),
            {
                name: SCAN_VERIFY_TOOL,
                description:
                    'Submit your verdict on the reported finding: keep it unless you found what refutes it.',
                inputSchema: SCAN_VERDICT_SCHEMA,
                execute: async () => ({ output: 'verdict recorded' }),
            },
        ]),
        policies: [
            new BudgetPolicy(),
            // Without it a verifier can spend every step reading and end with
            // no verdict; on the last steps it is told to answer.
            new ForceTextFinalizePolicy({
                answerDescription:
                    'your verdict as JSON with keep, severity, assumption and rationale',
                noToolsOnLastStep: true,
            }),
        ],
        maxSteps: VERIFY_MAX_STEPS,
        resultToolName: SCAN_VERIFY_TOOL,
        providerOptions: env.providerOptions,
    };
    const { ctx, cleanup } = createAgentRunContext({
        runId: `security-scan-verify:${lensInput.agentName ?? 'lens'}`,
        parentSignal: request.signal ?? lensInput.parentSignal,
    });
    try {
        const state = await env.finderRunner.run(
            spec,
            {
                prompt: request.userPrompt,
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(
                        `${spec.agentName}`,
                        lensInput.telemetryMetadata,
                    ),
                ),
            },
            ctx,
        );
        return readScanVerdict(state);
    } finally {
        cleanup();
    }
};

/**
 * The verdict of a verifier run: the verdict tool's payload, else the last
 * JSON object of its final answer. A run that failed, or answered with no
 * readable verdict, judged nothing: the finding is kept as reported.
 */
export function readScanVerdict(state: RunState): ScanVerdict {
    if (state.status === 'error') {
        return unjudged('the verifier run failed');
    }
    const payloads = [
        ...state.artifacts
            .filter((a) => a.type === SCAN_VERIFY_TOOL)
            .map((a) => a.payload)
            .reverse(),
    ];
    const last = state.steps[state.steps.length - 1]?.message?.content;
    if (typeof last === 'string' && last.trim()) {
        const fromText = extractLastJsonObjectWith(last, [
            'keep',
            'verdict',
            'decision',
        ]);
        if (fromText) payloads.push(fromText);
    }
    for (const payload of payloads) {
        const verdict = recoverVerdictObject(payload, undefined, {
            coerceKeep: true,
        });
        if (!verdict) continue;
        const raw = (
            payload && typeof payload === 'object' ? payload : {}
        ) as Record<string, unknown>;
        const severity = String(raw.severity ?? '').toLowerCase();
        const assumption =
            typeof raw.assumption === 'string' ? raw.assumption.trim() : '';
        return {
            keep: verdict.keep,
            severity: (SEVERITIES as readonly string[]).includes(severity)
                ? (severity as ScanFinding['severity'])
                : undefined,
            assumption: assumption || undefined,
            rationale: verdict.rationale ?? '',
            judged: true,
        };
    }
    return unjudged(`the verifier ended ${state.status} without a verdict`);
}

function unjudged(why: string): ScanVerdict {
    logger.warn({
        message: `Security finding left unverified: ${why}`,
        context: 'SecurityScanVerifier',
    });
    return { keep: true, rationale: why, judged: false };
}
