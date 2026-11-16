import type { EnvironmentSetupState } from '@libs/runtime/run';
import { PgEnvironmentSetupReads } from '@libs/runtime/run/adapters/pg-environment-setup.store';
import { RUN_COLUMNS, RUNTIME_RUNS_TABLE } from '@libs/runtime/run/adapters/pg-run-projection.store';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { PullRequestRef, PullRequestRunRecord, PullRequestRunsReader } from '../domain/pull-request-runs';

const READ_TIMEOUT_MS = 5_000;

/** The projection's columns the pull requests screens read. */
const RUN_FIELDS = ['runId', 'attempt', 'organizationId', 'repositoryId', 'prNumber', 'headSha', 'baseBranch', 'environmentId', 'state', 'verdictState', 'phase', 'requestedAt', 'startedAt', 'finishedAt'] as const;

/**
 * The parts of the report the screens read, per object of each list: the
 * probes' evidence, lanes, specs and step ids stay in the store.
 */
export const PULL_REQUEST_REPORT_FIELDS = {
    findings: ['probeId', 'entryPoint', 'verdict', 'intent', 'findingKind', 'differingFields', 'responseDiff'],
    probes: ['probeId', 'entryPoint', 'verdict', 'intent', 'findingKind'],
    reproductionProbes: ['probeId', 'purpose'],
    bootFailure: ['side'],
} as const;

/** These keys of each object of the jsonb array at `path`, in order; null when it is not an array. */
const pickEach = (path: string, keys: readonly string[]) =>
    `CASE WHEN jsonb_typeof(${path}) = 'array' THEN (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(${keys
        .map((k) => `'${k}', e.v->'${k}'`)
        .join(', ')})) ORDER BY e.n), '[]'::jsonb) FROM jsonb_array_elements(${path}) WITH ORDINALITY AS e(v, n)) END`;

const pickOne = (path: string, keys: readonly string[]) =>
    `CASE WHEN jsonb_typeof(${path}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(${keys.map((k) => `'${k}', ${path}->'${k}'`).join(', ')})) END`;

const F = PULL_REQUEST_REPORT_FIELDS;
const SELECT = [
    ...RUN_FIELDS.map((f) => RUN_COLUMNS.column(f)),
    `${pickEach(`report->'findings'`, F.findings)} AS findings`,
    `${pickEach(`report->'probes'`, F.probes)} AS probes`,
    `${pickEach(`report->'reproduction'->'probes'`, F.reproductionProbes)} AS reproduction_probes`,
    `${pickOne(`report->'bootFailure'`, F.bootFailure)} AS boot_failure`,
].join(',\n       ');

/** Reads runtime.runtime_runs and runtime.runtime_environment_setups for the pull requests screens; never writes. */
export class PgPullRequestRunsReader implements PullRequestRunsReader {
    private readonly setups: PgEnvironmentSetupReads;

    constructor(private readonly db: SqlQuery) {
        this.setups = new PgEnvironmentSetupReads(db);
    }

    /** Newest first, at most `perPullRequest` Runs per PR: one query for the whole page. */
    async listForPullRequests(input: { organizationId: string; pullRequests: PullRequestRef[]; perPullRequest: number }): Promise<PullRequestRunRecord[]> {
        if (!input.organizationId || input.pullRequests.length === 0) return [];
        const res = await this.db.query(
            `SELECT ${SELECT}
             FROM (SELECT r.*, row_number() OVER (PARTITION BY repository_id, pr_number ORDER BY requested_at DESC NULLS LAST) AS n
                   FROM ${RUNTIME_RUNS_TABLE} r
                   WHERE organization_id = $1 AND (repository_id, pr_number) IN (SELECT * FROM unnest($2::text[], $3::int[]))) ranked
             WHERE n <= $4
             ORDER BY repository_id, pr_number, requested_at DESC NULLS LAST`,
            [input.organizationId, input.pullRequests.map((p) => p.repositoryId), input.pullRequests.map((p) => p.prNumber), Math.max(1, Math.floor(input.perPullRequest))],
            { timeoutMs: READ_TIMEOUT_MS },
        );
        return res.rows.map((row) => {
            const { findings, probes, reproduction_probes, boot_failure, ...columns } = row;
            const run = RUN_COLUMNS.read({ ...columns, report: null }) as unknown as PullRequestRunRecord;
            return {
                ...run,
                ...(findings ? { findings } : {}),
                ...(probes ? { probes } : {}),
                ...(reproduction_probes ? { reproduction: { probes: reproduction_probes } } : {}),
                ...(boot_failure ? { bootFailure: boot_failure } : {}),
            };
        });
    }

    setupStates(organizationId: string, environmentIds: string[]): Promise<Map<string, EnvironmentSetupState>> {
        return this.setups.states(organizationId, environmentIds, READ_TIMEOUT_MS);
    }
}
