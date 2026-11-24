import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { type RuntimeSuitePublishRequested, suitePublishKey } from '@libs/runtime/run';
import { buildSuiteReport, type SuiteReport, suiteConclusionOf } from '@libs/runtime/suite';

import type { PgSuiteRuns } from './pg-suite-runs';
import type { SuiteServiceResult } from './suite-service';

/** What the publisher hands the broker: the Runtime's side of the publish queue (`AmqpSuitePublishRequester`). */
export interface SuitePublishRequester {
    request(msg: RuntimeSuitePublishRequested): Promise<void>;
}

const ZERO = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
const NO_CLASSES = { regression: 0, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 };

/**
 * The suite's check (docs/runtime/e2e-suites.md section 10.1) as the Runtime asks it: opened `in_progress` when the suite
 * starts, closed with the conclusion of the run's stored state. The report is read from what the run stored (the first-pass
 * results, the classification, how the specs were chosen, the baseline and the drift), so a replay publishes the same thing. A
 * baseline has no PR and publishes nothing; neither does an environment with no suite. Run mode and CI mode publish the same
 * check; they differ in the target the product stored (`targetId`: the Run, or the suite run) and in the link the product adds.
 */
export class SuitePublisher {
    constructor(
        private readonly runs: Pick<PgSuiteRuns, 'get' | 'results'>,
        private readonly requester: SuitePublishRequester,
    ) {}

    async started(cmd: RuntimeSuiteRequested): Promise<void> {
        if (cmd.mode === 'baseline') return;
        await this.requester.request({
            ...this.envelope(cmd, 'running'),
            check: { status: 'in_progress' },
            report: {
                state: 'running',
                mode: cmd.mode,
                mainSha: cmd.mainSha,
                ...(cmd.prSha ? { prSha: cmd.prSha } : {}),
                selection: { mode: 'full', total: 0 },
                totals: ZERO,
                classes: NO_CLASSES,
                annotations: [],
                annotationsOmitted: 0,
                requestedAt: cmd.requestedAt,
            },
        });
    }

    async finished(cmd: RuntimeSuiteRequested, result: SuiteServiceResult, suite: { cwd?: string }): Promise<void> {
        if (cmd.mode === 'baseline' || result.status === 'off') return;
        const report = await this.reportOf(cmd, result, suite);
        if (!report) return;
        await this.requester.request({ ...this.envelope(cmd, 'final'), check: { status: 'completed', conclusion: suiteConclusionOf(report.state) }, report });
    }

    /** The check of a suite that was cancelled before it had a stored run to report from (a cancel between the opening of the check and the engine): closed cancelled, with no results. */
    async cancelled(cmd: RuntimeSuiteRequested): Promise<void> {
        if (cmd.mode === 'baseline') return;
        await this.requester.request({
            ...this.envelope(cmd, 'final'),
            check: { status: 'completed', conclusion: suiteConclusionOf('cancelled') },
            report: {
                state: 'cancelled',
                mode: cmd.mode,
                mainSha: cmd.mainSha,
                ...(cmd.prSha ? { prSha: cmd.prSha } : {}),
                selection: { mode: 'full', total: 0 },
                totals: ZERO,
                classes: NO_CLASSES,
                annotations: [],
                annotationsOmitted: 0,
                requestedAt: cmd.requestedAt,
            },
        });
    }

    private envelope(cmd: RuntimeSuiteRequested, phase: 'running' | 'final') {
        return { suiteRunId: cmd.suiteRunId, targetId: cmd.targetId ?? cmd.suiteRunId, attempt: 1, key: suitePublishKey(cmd.suiteRunId, phase), correlationId: `suite-${cmd.suiteRunId}` };
    }

    private async reportOf(cmd: RuntimeSuiteRequested, result: Exclude<SuiteServiceResult, { status: 'off' }>, suite: { cwd?: string }): Promise<SuiteReport | undefined> {
        const run = await this.runs.get(cmd.organizationId, cmd.suiteRunId);
        if (!run || run.mode === 'baseline') return undefined;
        const results = await this.runs.results(cmd.organizationId, cmd.suiteRunId);
        const total = new Set(results.filter((r) => r.phase === 'shard').map((r) => r.spec)).size;
        return buildSuiteReport({
            run: {
                state: run.state,
                mode: run.mode,
                mainSha: run.mainSha,
                ...(run.prSha ? { prSha: run.prSha } : {}),
                ...(run.mergeBase ? { mergeBase: run.mergeBase } : {}),
                requestedAt: run.requestedAt.toISOString(),
                ...(run.finishedAt ? { finishedAt: run.finishedAt.toISOString() } : {}),
            },
            ...(suite.cwd ? { cwd: suite.cwd } : {}),
            results,
            ...(run.classification ? { classification: run.classification } : {}),
            // A run that never said how it chose ran the whole suite; no reason is invented for it.
            selection: run.selection ?? { mode: 'full', total },
            ...(run.baselineSha ? { baseline: { sha: run.baselineSha } } : {}),
            ...(run.baseDrift ? { baseDrift: run.baseDrift } : {}),
            ...(result.status === 'unavailable' ? { unavailable: result.reason } : {}),
        });
    }
}
