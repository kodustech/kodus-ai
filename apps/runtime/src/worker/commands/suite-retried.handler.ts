import { Logger } from '@nestjs/common';

import { uuidV5From, sha256 } from '@libs/runtime/contracts/derive-id';
import { RuntimeCommandName, RuntimeSuiteRetriedSchema, type RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import type { PgSuiteRuns } from '../suite/pg-suite-runs';
import type { CommandHandler } from './command-handlers';
import type { SuiteStarter } from './suite-requested.handler';

/** The run store the retry reads: the original run, its plan and its first-pass results. */
export type SuiteRetryRuns = Pick<PgSuiteRuns, 'get' | 'shards' | 'results'>;

/**
 * `runtime.suite.retried` (docs/runtime/e2e-suites.md section 11): a person asks to run one shard of a suite again, or every
 * spec that did not pass in it. The retry is a new suite run of the same commits, limited to those specs
 * (`RuntimeSuiteRequested.specs`), under an id derived from the retry's key so a redelivery finds it; the product mints its
 * download tokens and sends them with the command, since only it holds the credentials. Never waits for the run.
 */
export class SuiteRetriedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.SuiteRetried;
    private readonly logger = new Logger('SuiteRetried');
    constructor(
        private readonly runs: SuiteRetryRuns,
        private readonly suites: SuiteStarter,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeSuiteRetriedSchema.safeParse(body);
        if (!p.success) return { invalid: 'invalid suite retry', detail: p.error.message };
        const r = p.data;
        const original = await this.runs.get(r.organizationId, r.suiteRunId);
        if (!original) return { invalid: 'unknown suite run', detail: 'no suite run of this organization has that id' };
        if (!original.finishedAt) return { invalid: 'suite run still running', detail: 'a suite run is retried once it has ended' };
        if (!r.repoToken) return { invalid: 'no download token', detail: 'a retry brings the sealed tokens of its claims' };
        const specs = await this.specsOf(r, original.suiteRunId);
        if (specs.length === 0) return { invalid: 'nothing to retry', detail: r.scope === 'shard' ? 'the run has no such shard' : 'no spec of the run is left red' };
        const retry: RuntimeSuiteRequested = {
            suiteRunId: uuidV5From(sha256(`suite-retry:${r.organizationId}:${r.key}`)),
            organizationId: original.organizationId,
            environmentId: original.environmentId,
            repositoryId: original.repositoryId,
            ...(r.repositoryFullName ? { repositoryFullName: r.repositoryFullName } : {}),
            mode: original.mode,
            ...(original.prNumber !== undefined ? { prNumber: original.prNumber } : {}),
            ...(original.prSha ? { prSha: original.prSha } : {}),
            ...(original.mergeBase ? { mergeBase: original.mergeBase } : {}),
            mainSha: original.mainSha,
            requestedAt: r.requestedAt,
            key: r.key,
            repoToken: r.repoToken,
            ...(r.moreRepoTokens ? { moreRepoTokens: r.moreRepoTokens } : {}),
            specs,
        };
        const id = await this.suites.start(retry);
        if (id === false) this.logger.warn({ msg: 'suite.retry.no_service', suiteRunId: original.suiteRunId });
        else this.logger.log({ msg: 'suite.retry.enqueued', suiteRunId: original.suiteRunId, retryRunId: retry.suiteRunId, scope: r.scope, workflowId: id });
        return undefined;
    }

    /** The shard's planned specs, or the specs of the first pass that did not pass (failed, never reported, or lost to the host). */
    private async specsOf(r: { organizationId: string; scope: 'shard' | 'failed'; shard?: number }, suiteRunId: string): Promise<string[]> {
        if (r.scope === 'shard') return (await this.runs.shards(r.organizationId, suiteRunId)).find((s) => s.shard === r.shard)?.specs ?? [];
        const red = new Set(['failed', 'infra', 'not_run']);
        return (await this.runs.results(r.organizationId, suiteRunId))
            .filter((x) => x.phase === 'shard' && red.has(x.status))
            .map((x) => x.spec)
            .sort();
    }
}
