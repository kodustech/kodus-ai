/**
 * Business-rules analyzer verdict — the structured output of the analysis and
 * the single place that decides whether a completed analysis passed.
 *
 * The analyzer submits its result through the `submitValidation` result tool
 * (harness "result tool" convention: `AgentSpec.resultToolName`, materialized
 * into `RunState.artifacts`). Callers read `status`; the markdown `summary` is
 * only what gets shown to people. Pure — no IO, no LLM.
 */
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';

import type {
    ValidationFinding,
    ValidationResult,
    ValidationStatus,
} from './validation.types';

export const VALIDATION_RESULT_TOOL = 'submitValidation' as const;

export const VALIDATION_STATUSES: readonly ValidationStatus[] = [
    'compliant',
    'issues_found',
    'scope_mismatch',
];

const FINDING_SEVERITIES: readonly ValidationFinding['severity'][] = [
    'must_fix',
    'suggestion',
    'info',
];

export const VALIDATION_RESULT_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        needsMoreInfo: { type: 'boolean' },
        status: { type: 'string', enum: [...VALIDATION_STATUSES] },
        findings: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
                    title: { type: 'string' },
                },
                required: ['severity', 'title'],
            },
        },
        mode: {
            type: 'string',
            enum: ['full_analysis', 'limitation_response'],
        },
        reason: {
            type: 'string',
            enum: [
                'analysis_ready',
                'task_context_missing',
                'task_context_weak',
                'pr_diff_missing',
            ],
        },
        taskContextStatus: {
            type: 'string',
            enum: ['missing', 'weak', 'usable'],
        },
        prDiffStatus: { type: 'string', enum: ['missing', 'usable'] },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        missingInfo: { type: 'string' },
        summary: { type: 'string' },
    },
    required: ['needsMoreInfo', 'summary'],
};

export const submitValidationTool = {
    name: VALIDATION_RESULT_TOOL,
    description:
        'Submit the business rules validation result. Call it exactly once, with the full result.',
    inputSchema: VALIDATION_RESULT_SCHEMA,
    execute: async () => ({ output: 'validation recorded' }),
};

/** The payload of the last `submitValidation` call, if the analyzer made one. */
export function readValidationArtifact(state: RunState): unknown {
    for (let i = state.artifacts.length - 1; i >= 0; i--) {
        const artifact = state.artifacts[i];
        if (artifact.type === VALIDATION_RESULT_TOOL) {
            return artifact.payload;
        }
    }
    return undefined;
}

export function parseValidationStatus(
    value: unknown,
): ValidationStatus | undefined {
    return VALIDATION_STATUSES.find((status) => status === value);
}

export function parseValidationFindings(
    value: unknown,
): ValidationFinding[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    return value.flatMap((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const severity = FINDING_SEVERITIES.find(
            (candidate) => candidate === record.severity,
        );
        const title =
            typeof record.title === 'string' ? record.title.trim() : '';
        return severity ? [{ severity, title }] : [];
    });
}

/**
 * The verdict of a completed analysis: the analyzer's `status`, or — when it
 * left that out — what its findings say (any blocking or partial finding means
 * issues were found). `undefined` when the result carries neither, or did not
 * complete (`needsMoreInfo`).
 */
export function resolveValidationStatus(
    result: ValidationResult | undefined,
): ValidationStatus | undefined {
    if (!result || result.needsMoreInfo) {
        return undefined;
    }
    if (result.status) {
        return result.status;
    }
    if (!result.findings) {
        return undefined;
    }

    return result.findings.some(
        (finding) =>
            finding.severity === 'must_fix' ||
            finding.severity === 'suggestion',
    )
        ? 'issues_found'
        : 'compliant';
}
