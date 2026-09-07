import { createHash } from 'crypto';

import { ReviewExecutionPlan } from './review-risk-planner';
import { ReviewPolicy } from './review-policy';

export interface ReviewExecutionSnapshot {
    schemaVersion: '1';
    createdAt: string;
    policyVersion: string;
    policyHash: string;
    configHash: string;
    promptHash?: string;
    rules: {
        count: number;
        ids: string[];
        contentHash?: string;
    };
    model: {
        provider?: string;
        model?: string;
        modelId?: string;
    };
    plan: ReviewExecutionPlan;
}

function stable(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, stable(item)]),
        );
    }
    return value;
}

export function hashReviewSnapshotValue(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(stable(value)))
        .digest('hex');
}

export function createReviewExecutionSnapshot(input: {
    policy: ReviewPolicy;
    plan: ReviewExecutionPlan;
    safeConfig: unknown;
    promptOverrides?: unknown;
    rules?: Array<{ uuid?: string }>;
    model: ReviewExecutionSnapshot['model'];
}): ReviewExecutionSnapshot {
    const rules = input.rules ?? [];
    return {
        schemaVersion: '1',
        createdAt: new Date().toISOString(),
        policyVersion: input.policy.version,
        policyHash: hashReviewSnapshotValue(input.policy),
        configHash: hashReviewSnapshotValue(input.safeConfig),
        promptHash: input.promptOverrides
            ? hashReviewSnapshotValue(input.promptOverrides)
            : undefined,
        rules: {
            count: rules.length,
            ids: rules
                .map((rule) => rule.uuid)
                .filter((uuid): uuid is string => Boolean(uuid))
                .sort(),
            contentHash:
                rules.length > 0 ? hashReviewSnapshotValue(rules) : undefined,
        },
        model: input.model,
        plan: input.plan,
    };
}
