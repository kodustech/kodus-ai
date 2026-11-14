import { z } from 'zod';

import { ProbeSchema } from '@libs/runtime/probe/probe.schema';
import { browserSelectorProblem } from './browser-exploration';

/** ADR-023/049: external observations are bounded input data, never replay proof. */
export const EXTERNAL_FINDING_LIMITS = {
    maxFindings: 10,
    bodyBytes: 256 * 1024,
    observationBytes: 16 * 1024,
} as const;
const id = z.string().min(1).max(128);
const sha = z.string().regex(/^[0-9a-f]{40}$/);

function withinJSONBudget(value: unknown, bytes: number): boolean {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes;
    } catch {
        return false;
    }
}

function boundedObservation(value: unknown): boolean {
    const pending = [{ value, depth: 0 }];
    let count = 0;
    while (pending.length) {
        const item = pending.pop()!;
        if (++count > 1024 || item.depth > 16) return false;
        const v = item.value;
        if (v === null || typeof v === 'string' || typeof v === 'boolean')
            continue;
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) return false;
            continue;
        }
        if (typeof v !== 'object') return false;
        for (const [key, child] of Object.entries(v)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key))
                return false;
            pending.push({ value: child, depth: item.depth + 1 });
        }
    }
    return withinJSONBudget(value, EXTERNAL_FINDING_LIMITS.observationBytes);
}

export const ExternalFindingSourceSchema = z.strictObject({
    name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/),
    version: z.string().min(1).max(64).optional(),
});
export type ExternalFindingSource = z.infer<typeof ExternalFindingSourceSchema>;

/** Only the observer's closed probes; no external shell/setup/webhook authority. */
export const ExternalFindingProbeSchema = ProbeSchema.superRefine(
    (probe, ctx) => {
        if (probe.spec.kind === 'shell' || probe.waitFor || probe.sendWebhook) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'external verification accepts observer probes only, without shell waits or webhook controls',
            });
        }
        if (probe.spec.kind === 'browser') {
            const steps = probe.spec.steps;
            const invalidSelector = steps.some((step) => {
                const selector =
                    'click' in step
                        ? step.click
                        : 'fill' in step
                          ? step.fill[0]
                          : 'select' in step
                            ? step.select[0]
                            : 'waitFor' in step
                              ? step.waitFor
                              : 'expectText' in step
                                ? step.expectText[0]
                                : 'getAttribute' in step
                                  ? step.getAttribute[0]
                                  : undefined;
                return (
                    selector !== undefined && browserSelectorProblem(selector)
                );
            });
            if (
                !('goto' in steps[0]) ||
                !steps.some(
                    (step) =>
                        'screenshot' in step ||
                        'expectText' in step ||
                        'getAttribute' in step,
                ) ||
                invalidSelector
            ) {
                ctx.addIssue({
                    code: 'custom',
                    message:
                        'external browser probes start with goto, use stable CSS selectors and measure an observation',
                });
            }
        }
        if (probe.spec.kind === 'http' && probe.spec.body) {
            const headers = Object.entries(probe.spec.headers ?? {}).filter(
                ([key]) => key.toLowerCase() === 'content-type',
            );
            if (headers.length !== 1 || !headers[0][1].trim())
                ctx.addIssue({
                    code: 'custom',
                    message:
                        'a nonempty HTTP body requires one explicit nonempty Content-Type header',
                });
        }
    },
);
export const ExternalFindingInputSchema = z.strictObject({
    title: z.string().min(1).max(256),
    severity: z.enum(['high', 'medium', 'low']),
    location: z
        .strictObject({
            file: z.string().min(1).max(1024),
            line: z.number().int().min(1).max(10_000_000),
        })
        .optional(),
    rationale: z.string().min(1).max(4096),
    evidence: z
        .strictObject({
            probe: ExternalFindingProbeSchema.optional(),
            observed: z
                .unknown()
                .refine(boundedObservation, {
                    message: 'external observations must be bounded JSON data',
                })
                .optional(),
        })
        .optional(),
});
export type ExternalFindingInput = z.infer<typeof ExternalFindingInputSchema>;

export const SubmitFindingsSchema = z
    .strictObject({
        repositoryId: id,
        prNumber: z.number().int().min(1),
        headSha: sha,
        source: ExternalFindingSourceSchema,
        findings: z
            .array(ExternalFindingInputSchema)
            .min(1)
            .max(EXTERNAL_FINDING_LIMITS.maxFindings),
    })
    .refine(
        (value) => withinJSONBudget(value, EXTERNAL_FINDING_LIMITS.bodyBytes),
        { message: 'external finding submission exceeds its byte budget' },
    );
export type SubmitFindings = z.infer<typeof SubmitFindingsSchema>;
export const VerifyFindingSchema = z.strictObject({ findingId: z.uuid() });
export type VerifyFinding = z.infer<typeof VerifyFindingSchema>;

export const ExternalVerificationSchema = z
    .strictObject({
        taskId: z.uuid(),
        source: ExternalFindingSourceSchema,
        findings: z
            .array(
                z.strictObject({
                    findingId: z.uuid(),
                    probe: ExternalFindingProbeSchema,
                }),
            )
            .min(1)
            .max(EXTERNAL_FINDING_LIMITS.maxFindings),
    })
    .superRefine((value, ctx) => {
        const ids = new Set<string>();
        for (const finding of value.findings) {
            if (
                finding.probe.id !== finding.findingId ||
                finding.probe.origin !== 'external' ||
                ids.has(finding.findingId)
            ) {
                ctx.addIssue({
                    code: 'custom',
                    message:
                        'verification probes require unique server-bound finding IDs and external origin',
                });
            }
            ids.add(finding.findingId);
        }
    });
export type ExternalVerification = z.infer<typeof ExternalVerificationSchema>;
