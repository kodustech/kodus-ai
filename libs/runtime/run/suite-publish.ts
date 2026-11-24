import { z } from 'zod';

import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { ANNOTATION_MESSAGE_MAX, ANNOTATION_TITLE_MAX, ANNOTATIONS_MAX, FULL_REASONS, SUITE_REPORT_STATES, SUITE_UNAVAILABLE_REASONS } from '@libs/runtime/suite';

import { CHECK_CONCLUSIONS } from '@libs/runtime/contracts/enums';

import { RUNTIME_PUBLISH_ROUTING_KEY, runtimeEnvelope } from './run-messages';

// What the Runtime asks the product to publish of an e2e suite run (docs/runtime/e2e-suites.md section 10.1): the suite's own
// check, `Kody Runtime e2e`, with a structured report. It travels the Runtime's publish queue under its own event name; the
// product renders the report and names the target from its own record (`targetId`: the Run's id in Run mode, the suite run's
// in CI mode), never from the message. Like the Run's publication, no sentence of the Runtime's own reaches the PR.

export const SUITE_PUBLISH_EVENT = 'runtime.suite.publish_requested';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const count = z.number().int().min(0).max(1_000_000);

export const SuiteReportSchema = z.strictObject({
    state: z.enum(SUITE_REPORT_STATES),
    mode: z.enum(['run', 'ci']),
    mainSha: sha,
    prSha: sha.optional(),
    baseline: z.strictObject({ sha }).optional(),
    baseDrift: count.optional(),
    selection: z.strictObject({ mode: z.enum(['full', 'selected', 'none']), reason: z.enum(FULL_REASONS).optional(), selected: count.optional(), total: count, reachUnknown: z.enum(FULL_REASONS).optional() }),
    totals: z.strictObject({ passed: count, failed: count, skipped: count, notRun: count }),
    classes: z.strictObject({ regression: count, preExisting: count, flaky: count, unclassified: count, infra: count }),
    durationMs: z.number().int().min(0).optional(),
    annotations: z
        .array(
            z.strictObject({
                path: z.string().min(1).max(512),
                line: z.number().int().min(1).max(10_000_000),
                level: z.enum(['failure', 'warning']),
                title: z.string().max(ANNOTATION_TITLE_MAX),
                message: z.string().max(ANNOTATION_MESSAGE_MAX),
            }),
        )
        .max(ANNOTATIONS_MAX),
    annotationsOmitted: count,
    unavailable: z.enum(SUITE_UNAVAILABLE_REASONS).optional(),
    requestedAt: z.iso.datetime(),
});

export const RuntimeSuitePublishRequestedSchema = z
    .strictObject({
        suiteRunId: z.uuid(),
        /** The id the product stored the publish target under. */
        targetId: z.string().min(1).max(128),
        attempt: z.number().int().min(1),
        /** `suitePublishKey`. */
        key: z.string().min(1).max(256),
        correlationId: z.string().min(1).max(128),
        check: z.strictObject({ status: z.enum(['queued', 'in_progress', 'completed']), conclusion: z.enum(CHECK_CONCLUSIONS).optional() }),
        report: SuiteReportSchema,
    })
    .refine((m) => (m.check.status === 'completed') === (m.check.conclusion !== undefined), { message: 'a completed check names its conclusion, an open one none', path: ['check'] });
export type RuntimeSuitePublishRequested = z.infer<typeof RuntimeSuitePublishRequestedSchema>;

/** `<suiteRunId>:suite:check` for the verdict, `<suiteRunId>:suite:check:running` for the check while the suite runs. */
export const suitePublishKey = (suiteRunId: string, phase: 'running' | 'final') => (phase === 'final' ? `${suiteRunId}:suite:check` : `${suiteRunId}:suite:check:running`);

/** The broker envelope and routing key of a suite publication: the Runtime's publish route, under the suite's event name. */
export function suitePublishEnvelope(msg: RuntimeSuitePublishRequested) {
    return {
        routingKey: RUNTIME_PUBLISH_ROUTING_KEY,
        envelope: runtimeEnvelope(SUITE_PUBLISH_EVENT, { ...msg, workflowType: WorkflowType.RUNTIME_PUBLISH }, msg.key),
    };
}
