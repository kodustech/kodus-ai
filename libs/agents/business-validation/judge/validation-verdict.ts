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

import { asRecord } from '../value-utils';
import {
    REQUIREMENT_TOPICS,
    type CodeLocation,
    Confidence,
    OutOfScopeChange,
    RequirementState,
    RequirementVerdict,
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

const LOCATION_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        file: { type: 'string' },
        line: { type: 'number' },
    },
    required: ['file'],
};

export const REQUIREMENT_STATES: readonly RequirementState[] = [
    'met',
    'partial',
    'missing',
    'check_manually',
];

const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];
const REQUIREMENT_KINDS = ['behavior', 'visual', 'flow'] as const;

export const VALIDATION_RESULT_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        needsMoreInfo: { type: 'boolean' },
        requirements: {
            type: 'array',
            description:
                'One entry per requirement of the task, in the order the task lists them.',
            items: {
                type: 'object',
                properties: {
                    requirement: {
                        type: 'string',
                        description:
                            'The requirement, quoted from the task when possible.',
                    },
                    source: {
                        type: 'string',
                        description: 'Where in the task, e.g. "AC #2".',
                    },
                    state: { type: 'string', enum: [...REQUIREMENT_STATES] },
                    kind: { type: 'string', enum: [...REQUIREMENT_KINDS] },
                    topic: {
                        type: 'string',
                        enum: [...REQUIREMENT_TOPICS],
                        description: 'The area the requirement is about.',
                    },
                    evidence: { type: 'array', items: LOCATION_SCHEMA },
                    note: {
                        type: 'string',
                        description:
                            'What the diff does or lacks for this requirement, in USER LANGUAGE.',
                    },
                    action: {
                        type: 'string',
                        description:
                            'For partial or missing: the change to make, in USER LANGUAGE.',
                    },
                    confidence: { type: 'string', enum: [...CONFIDENCES] },
                },
                required: ['requirement', 'state', 'confidence'],
            },
        },
        outOfScope: {
            type: 'array',
            description:
                'Changes in the diff the task does not ask for. Leave out refactors and tests that serve a requirement.',
            items: {
                type: 'object',
                properties: {
                    change: { type: 'string' },
                    evidence: { type: 'array', items: LOCATION_SCHEMA },
                    action: { type: 'string' },
                },
                required: ['change'],
            },
        },
        scopeMismatch: {
            type: 'boolean',
            description:
                'True when the whole diff works on a different domain than the task.',
        },
        confidence: { type: 'string', enum: [...CONFIDENCES] },
        missingInfo: {
            type: 'string',
            description:
                'When needsMoreInfo is true: what the task lacks, in USER LANGUAGE.',
        },
        summary: {
            type: 'string',
            description: 'One sentence on the result, in USER LANGUAGE.',
        },
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

export function parseRequirements(
    value: unknown,
): RequirementVerdict[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.flatMap((item) => {
        const record = asRecord(item);
        const requirement = text(record.requirement);
        const state = REQUIREMENT_STATES.find((s) => s === record.state);
        if (!requirement || !state) {
            return [];
        }
        const kind = REQUIREMENT_KINDS.find((k) => k === record.kind);
        const topic = REQUIREMENT_TOPICS.find((t) => t === record.topic);
        return [
            {
                requirement,
                source: text(record.source),
                state,
                ...(kind ? { kind } : {}),
                ...(topic ? { topic } : {}),
                evidence: parseLocations(record.evidence),
                note: text(record.note),
                action: text(record.action),
                confidence:
                    CONFIDENCES.find((c) => c === record.confidence) ??
                    'medium',
            },
        ];
    });
}

export function parseOutOfScope(
    value: unknown,
): OutOfScopeChange[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.flatMap((item) => {
        const record = asRecord(item);
        const change = text(record.change);
        return change
            ? [
                  {
                      change,
                      evidence: parseLocations(record.evidence),
                      action: text(record.action),
                  },
              ]
            : [];
    });
}

function parseLocations(value: unknown): CodeLocation[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((item) => {
        const record = asRecord(item);
        const file = text(record.file);
        if (!file) {
            return [];
        }
        const line = Number(record.line);
        return [Number.isInteger(line) && line > 0 ? { file, line } : { file }];
    });
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The status and findings older readers expect, from the requirement list.
 * A requirement someone accepted no longer counts against the PR.
 */
export function deriveStatus(
    result: Pick<ValidationResult, 'requirements' | 'outOfScope' | 'status'> & {
        scopeMismatch?: boolean;
    },
): { status: ValidationStatus; findings: ValidationFinding[] } {
    const requirements = result.requirements ?? [];
    const outOfScope = result.outOfScope ?? [];
    const findings: ValidationFinding[] = [
        ...requirements
            .filter(
                (r) =>
                    !r.accepted &&
                    (r.state === 'missing' || r.state === 'partial'),
            )
            .map((r) => ({
                severity:
                    r.state === 'missing'
                        ? ('must_fix' as const)
                        : ('suggestion' as const),
                title: r.requirement,
            })),
        ...outOfScope
            .filter((c) => !c.accepted)
            .map((c) => ({ severity: 'suggestion' as const, title: c.change })),
    ];
    if (result.scopeMismatch) {
        return {
            status: 'scope_mismatch',
            findings: [
                {
                    severity: 'must_fix',
                    title: 'PR scope does not match the task scope',
                },
                ...findings,
            ],
        };
    }
    return {
        status: findings.length ? 'issues_found' : 'compliant',
        findings,
    };
}
