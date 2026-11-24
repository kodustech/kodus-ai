import type { SuiteReport } from '@libs/runtime/suite';

import { RUNTIME_PUBLISH_ROUTING_KEY } from './run-messages';
import { RuntimeSuitePublishRequestedSchema, SUITE_PUBLISH_EVENT, suitePublishEnvelope, suitePublishKey } from './suite-publish';

const ID = '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11';
const report: SuiteReport = {
    state: 'failed',
    mode: 'ci',
    mainSha: 'a'.repeat(40),
    prSha: 'b'.repeat(40),
    selection: { mode: 'full', reason: 'map_missing', total: 12 },
    totals: { passed: 10, failed: 1, skipped: 0, notRun: 1 },
    classes: { regression: 1, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 },
    annotations: [{ path: 'cypress/e2e/a.cy.ts', line: 12, level: 'failure', title: 'works', message: 'expected 3' }],
    annotationsOmitted: 0,
    requestedAt: '2026-11-23T12:00:00.000Z',
};
const msg = (over: Record<string, unknown> = {}) => ({
    suiteRunId: ID,
    targetId: ID,
    attempt: 1,
    key: suitePublishKey(ID, 'final'),
    correlationId: `suite-${ID}`,
    check: { status: 'completed', conclusion: 'failure' },
    report,
    ...over,
});

describe('the suite publication the Runtime asks of the product', () => {
    it('has one key per phase of the suite run, the final one without a suffix', () => {
        expect(suitePublishKey(ID, 'final')).toBe(`${ID}:suite:check`);
        expect(suitePublishKey(ID, 'running')).toBe(`${ID}:suite:check:running`);
    });

    it('is structured fields only: a report, a check state, and nothing that names a target', () => {
        expect(RuntimeSuitePublishRequestedSchema.safeParse(msg()).success).toBe(true);
        for (const bad of [{ comment: { body: 'hi' } }, { check: { status: 'completed' } }, { report: { ...report, selection: { mode: 'full', reason: 'free text', total: 1 } } }, { report: { ...report, annotations: [{ ...report.annotations[0], level: 'info' }] } }, { report: { ...report, annotations: [{ ...report.annotations[0], line: 0 }] } }]) {
            expect(RuntimeSuitePublishRequestedSchema.safeParse(msg(bad)).success).toBe(false);
        }
    });

    it('an open check carries no conclusion, and a completed one carries one', () => {
        expect(RuntimeSuitePublishRequestedSchema.safeParse(msg({ check: { status: 'in_progress' } })).success).toBe(true);
        expect(RuntimeSuitePublishRequestedSchema.safeParse(msg({ check: { status: 'in_progress', conclusion: 'success' } })).success).toBe(false);
    });

    it('travels in the publish envelope, under its own event name and the publish routing key', () => {
        const e = suitePublishEnvelope(RuntimeSuitePublishRequestedSchema.parse(msg()));
        expect(e.routingKey).toBe(RUNTIME_PUBLISH_ROUTING_KEY);
        expect(e.envelope).toMatchObject({ event_name: SUITE_PUBLISH_EVENT, messageId: suitePublishKey(ID, 'final') });
        expect((e.envelope.payload as Record<string, unknown>).workflowType).toBe('RUNTIME_PUBLISH');
    });
});
