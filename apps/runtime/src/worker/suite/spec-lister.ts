import picomatch from 'picomatch';

import { isBlocked } from '@libs/runtime/environment';
import type { SuiteSpecFile } from '@libs/runtime/suite';

import type { SuiteEnvironment } from './suite-environment';
import { acquireSuiteClaim, HOST_WAIT_MS, type SuiteHostDemand } from './suite-engine';

/** The demand row and claim of the spec listing: beside the plan's shards 0..N-1 and the fresh (62) and main (63) hosts. */
export const LIST_HOST_SHARD = 61;
const POLL_MS = 5_000;
const REFRESH_MS = 45_000;
const EXEC_TIMEOUT_MS = 60_000;
const SAFE_DIR = /^[A-Za-z0-9_.\/@+-]{1,256}$/;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `blocker`: the signature the claim was refused with, so a neutral suite says why (never a free message). */
export type SpecListing = { status: 'listed'; specs: SuiteSpecFile[] } | { status: 'unavailable'; reason: 'template_missing' | 'no_host' | 'list_failed'; blocker?: string };

export interface SpecListerDeps {
    env: SuiteEnvironment;
    demand: SuiteHostDemand;
    clock: { now(): number; sleep(ms: number): Promise<void> };
}

/**
 * The spec files of main's checkout (docs/runtime/e2e-suites.md section 3: "the engine lists it"), read on a suite host:
 * a short claim at main's commit, no PR build, one `find` under the glob's fixed directory (never node_modules). The list
 * is main's; the PR's added and removed specs are applied on top of it (`specListOf`). The host starts from the
 * environment's template, or with none ready from the cell base and builds main cold (section 5, "Template"): the PR side
 * runs either way, only the main re-run waits for a template (suite-engine.ts mainRerun). No host or a listing that did
 * not finish is `unavailable`, never a guess at the specs.
 */
export class TemplateSpecLister {
    constructor(private readonly d: SpecListerDeps) {}

    async list(run: { organizationId: string; environmentId: string; suiteRunId: string; mainSha: string }, suite: { cwd?: string; specsGlob: string }): Promise<SpecListing> {
        const root = picomatch.scan(suite.specsGlob).base || '.';
        if (!SAFE_DIR.test(root)) return { status: 'unavailable', reason: 'list_failed' };
        await this.d.demand.request({ organizationId: run.organizationId, environmentId: run.environmentId, suiteRunId: run.suiteRunId, shards: [LIST_HOST_SHARD] });
        if (!(await this.hostCame(run))) return { status: 'unavailable', reason: 'no_host' };
        const claim = await acquireSuiteClaim(this.d.env, {
            organizationId: run.organizationId,
            environmentId: run.environmentId,
            runId: run.suiteRunId,
            ref: { side: 'base', sha: run.mainSha },
            consumer: 'suite',
            idempotencyKey: `suite:${run.suiteRunId}:${LIST_HOST_SHARD}:list`,
            suiteRunId: run.suiteRunId,
            shard: LIST_HOST_SHARD,
        }, this.d.clock, this.d.clock.now() + HOST_WAIT_MS);
        if (isBlocked(claim)) {
            const blocker = claim.blockers[0]?.signature;
            return { status: 'unavailable', reason: 'no_host', ...(blocker ? { blocker } : {}) };
        }
        try {
            const r = await this.d.env.exec(claim.claimId, {
                stepId: `${run.suiteRunId}-list`,
                command: `find ${quote(root)} -type f -not -path '*/node_modules/*' -exec wc -c {} +`,
                ...(suite.cwd ? { cwd: suite.cwd } : {}),
                timeoutMs: EXEC_TIMEOUT_MS,
            });
            if (!('transport' in r) || r.transport !== 'ok' || r.exitCode !== 0 || r.truncated) return { status: 'unavailable', reason: 'list_failed' };
            return { status: 'listed', specs: parseWc(r.stdout) };
        } finally {
            await this.d.env.release(claim.claimId).catch(() => undefined);
        }
    }

    private async hostCame(run: { organizationId: string; environmentId: string; suiteRunId: string }): Promise<boolean> {
        const { clock, demand } = this.d;
        const deadline = clock.now() + HOST_WAIT_MS;
        let askedAt = clock.now();
        for (;;) {
            const state = (await demand.status()).find((h) => h.shard === LIST_HOST_SHARD)?.state ?? 'starting';
            if (state === 'ready') return true;
            if (state === 'failed' || clock.now() >= deadline) return false;
            await clock.sleep(POLL_MS);
            if (clock.now() - askedAt >= REFRESH_MS) {
                await demand.request({ ...run, shards: [LIST_HOST_SHARD] });
                askedAt = clock.now();
            }
        }
    }
}

/** `wc -c` output: "<bytes> <path>" per file and a "total" line when more than one. */
function parseWc(stdout: string): SuiteSpecFile[] {
    const out: SuiteSpecFile[] = [];
    for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+) (.+)$/.exec(line);
        if (!m || m[2] === 'total') continue;
        out.push({ path: m[2].replace(/^\.\//, ''), sizeBytes: Number(m[1]) });
    }
    return out;
}
