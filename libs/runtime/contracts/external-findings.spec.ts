import { randomUUID } from 'crypto';
import {
    SubmitFindingsSchema,
    VerifyFindingSchema,
    ExternalVerificationSchema,
} from './external-findings';
import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';
import { shopRunRequest } from '../../../apps/runtime/src/e2e/fixtures';

const findingId = randomUUID();
const probe = {
    id: findingId,
    origin: 'external',
    purpose: 'empty order is refused',
    expected: '400',
    compare: ['status'],
    spec: {
        kind: 'http',
        target: { service: 'web', port: 3000 },
        method: 'POST',
        path: '/orders',
        timeoutMs: 1000,
    },
};
const input = {
    repositoryId: 'repo-a',
    prNumber: 7,
    headSha: 'a'.repeat(40),
    source: { name: 'fixture-agent', version: '1.0' },
    findings: [
        {
            title: 'empty order crashes',
            severity: 'high',
            rationale: 'quantity validation is missing',
            evidence: { probe, observed: { status: 500 } },
        },
    ],
};
const verification = {
    taskId: randomUUID(),
    source: input.source,
    findings: [{ findingId, probe }],
};

describe('external finding contracts', () => {
    it('accepts bounded structured observations as data and optional executable evidence', () => {
        expect(SubmitFindingsSchema.parse(input)).toEqual(input);
        expect(
            SubmitFindingsSchema.safeParse({
                ...input,
                findings: [
                    {
                        title: 'read-only allegation',
                        severity: 'low',
                        rationale: 'not independently proved',
                    },
                ],
            }).success,
        ).toBe(true);
        expect(VerifyFindingSchema.safeParse({ findingId }).success).toBe(true);
    });
    it.each([
        { ...input, callbackUrl: 'https://outside.invalid' },
        { ...input, headSha: 'not-a-sha' },
        { ...input, findings: [] },
        { ...input, findings: Array(11).fill(input.findings[0]) },
        {
            ...input,
            findings: [
                {
                    ...input.findings[0],
                    evidence: { probe, observed: 'x'.repeat(17000) },
                },
            ],
        },
    ])('refuses unknown controls, invalid heads and payload budgets', (raw) => {
        expect(SubmitFindingsSchema.safeParse(raw).success).toBe(false);
    });
    it.each([
        { ...probe, spec: { kind: 'shell', command: 'true', timeoutMs: 1000 } },
        { ...probe, waitFor: { until: 'true', timeoutMs: 1000 } },
        {
            ...probe,
            sendWebhook: { fake: 'stripe', event: 'payment', payload: {} },
        },
    ])(
        'refuses internal execution paths in externally submitted probes',
        (unsafe) => {
            expect(
                SubmitFindingsSchema.safeParse({
                    ...input,
                    findings: [
                        { ...input.findings[0], evidence: { probe: unsafe } },
                    ],
                }).success,
            ).toBe(false);
        },
    );
    it.each([
        {
            kind: 'http',
            target: { service: 'web', port: 3000 },
            method: 'POST',
            path: '/orders',
            body: '{}',
            timeoutMs: 1000,
        },
        {
            kind: 'browser',
            viewport: { width: 1280, height: 720 },
            timeoutMs: 1000,
            steps: [{ click: 'button' }, { screenshot: 'page' }],
        },
        {
            kind: 'browser',
            viewport: { width: 1280, height: 720 },
            timeoutMs: 1000,
            steps: [{ goto: '/' }, { click: '@e1' }, { screenshot: 'page' }],
        },
        {
            kind: 'browser',
            viewport: { width: 1280, height: 720 },
            timeoutMs: 1000,
            steps: [{ goto: '/' }, { click: '#button' }],
        },
    ])(
        'preserves closed planner request and browser checks for external probes',
        (spec) => {
            expect(
                SubmitFindingsSchema.safeParse({
                    ...input,
                    findings: [
                        {
                            ...input.findings[0],
                            evidence: { probe: { ...probe, spec } },
                        },
                    ],
                }).success,
            ).toBe(false);
        },
    );
    it('requires exact server-bound IDs and external origin, with no submitted observations in Runtime input', () => {
        expect(ExternalVerificationSchema.safeParse(verification).success).toBe(
            true,
        );
        for (const findings of [
            [{ findingId, probe: { ...probe, id: 'client-label' } }],
            [{ findingId, probe: { ...probe, origin: 'agent' } }],
            [{ findingId, probe, observed: { status: 500 } }],
            [
                { findingId, probe },
                { findingId, probe },
            ],
        ])
            expect(
                ExternalVerificationSchema.safeParse({
                    ...verification,
                    findings,
                }).success,
            ).toBe(false);
    });
    it('refuses cyclic non-JSON observations without throwing past safeParse', () => {
        const observed: Record<string, unknown> = {};
        observed.self = observed;
        const raw = {
            ...input,
            findings: [{ ...input.findings[0], evidence: { probe, observed } }],
        };
        expect(() => SubmitFindingsSchema.safeParse(raw)).not.toThrow();
        expect(SubmitFindingsSchema.safeParse(raw).success).toBe(false);
    });
    it('pairs the external trigger and metadata on the strict Run contract', () => {
        const req = shopRunRequest({
            trigger: 'external_finding',
            externalVerification: verification,
        } as any);
        expect(RuntimeRunRequestedSchema.safeParse(req).success).toBe(true);
        expect(
            RuntimeRunRequestedSchema.safeParse({
                ...req,
                externalVerification: undefined,
            }).success,
        ).toBe(false);
        expect(
            RuntimeRunRequestedSchema.safeParse({
                ...req,
                trigger: 'pull_request',
            }).success,
        ).toBe(false);
    });
});
