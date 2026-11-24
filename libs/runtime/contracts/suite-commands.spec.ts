import { RuntimeCommandName, RuntimeSuiteRequestedSchema, RuntimeSuiteRetriedSchema, isRunLaneEvent, runtimeCommandOutboxMessage, runtimeCommandRoute } from './runtime-commands';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const requestedAt = '2026-11-23T12:00:00.000Z';
const actor = { userId: 'user-1' };

const pr = { suiteRunId: '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11', organizationId: 'org-a', environmentId: 'env-1', repositoryId: 'repo-1', mode: 'ci' as const, prNumber: 7, prSha: A, mergeBase: B, mainSha: B, requestedAt, key: 'suite:0b5c2f6e' };

describe('the suite commands', () => {
    it('a PR suite request round-trips through the outbox with its own name and the Run lane', () => {
        const msg = runtimeCommandOutboxMessage(RuntimeCommandName.SuiteRequested, pr, 'm-1');
        const body = msg.payload as { eventName?: string; payload?: Record<string, unknown> } & Record<string, unknown>;
        expect(JSON.stringify(body)).toContain(RuntimeCommandName.SuiteRequested);
        expect(RuntimeSuiteRequestedSchema.parse(pr)).toEqual(pr);
        // A suite is work like a setup: it waits with the Runs, never behind or in front of a stop.
        expect(isRunLaneEvent(RuntimeCommandName.SuiteRequested)).toBe(true);
        expect(runtimeCommandRoute(RuntimeCommandName.SuiteRequested).routingKey).toBe(msg.routingKey);
    });

    it('a baseline names the main commit alone, and a PR suite names its PR, head and merge base', () => {
        expect(RuntimeSuiteRequestedSchema.safeParse({ suiteRunId: pr.suiteRunId, organizationId: 'org-a', environmentId: 'env-1', repositoryId: 'repo-1', mode: 'baseline', mainSha: B, requestedAt, key: 'k' }).success).toBe(true);
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, mode: 'baseline' }).success).toBe(false);
        for (const missing of ['prSha', 'mergeBase', 'prNumber'] as const) {
            const { [missing]: _gone, ...rest } = pr;
            expect(RuntimeSuiteRequestedSchema.safeParse(rest).success).toBe(false);
        }
    });

    it('a shadow run (the whole suite in the background, D14) names its PR, head and merge base like a PR suite, and is no baseline', () => {
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, mode: 'shadow' }).success).toBe(true);
        const { prSha: _gone, ...noHead } = pr;
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...noHead, mode: 'shadow' }).success).toBe(false);
    });

    it('refuses a mode it does not know, a short sha, an unknown key and a plain token', () => {
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, mode: 'nightly' }).success).toBe(false);
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, prSha: 'abc' }).success).toBe(false);
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, extra: 1 }).success).toBe(false);
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, repoToken: 'ghs_plain' }).success).toBe(false);
    });

    it('a retry names one shard, or asks for every failed spec again', () => {
        const base = { suiteRunId: pr.suiteRunId, organizationId: 'org-a', requestedBy: actor, requestedAt, key: 'k-retry' };
        expect(RuntimeSuiteRetriedSchema.safeParse({ ...base, scope: 'shard', shard: 2 }).success).toBe(true);
        expect(RuntimeSuiteRetriedSchema.safeParse({ ...base, scope: 'failed' }).success).toBe(true);
        expect(RuntimeSuiteRetriedSchema.safeParse({ ...base, scope: 'shard' }).success).toBe(false);
        expect(RuntimeSuiteRetriedSchema.safeParse({ ...base, scope: 'failed', shard: 2 }).success).toBe(false);
        expect(runtimeCommandRoute(RuntimeCommandName.SuiteRetried).routingKey).toBe(runtimeCommandOutboxMessage(RuntimeCommandName.SuiteRetried, { ...base, scope: 'failed' }, 'm-2').routingKey);
    });

    it('carries one sealed download token per claim, because the cell revokes a token after it fetches', () => {
        const sealed = 'sealed:v1:abc';
        const ok = RuntimeSuiteRequestedSchema.safeParse({ ...pr, repoToken: sealed, moreRepoTokens: [sealed, sealed] });
        expect(ok.success).toBe(true);
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, moreRepoTokens: ['ghs_plain'] }).success).toBe(false);
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, moreRepoTokens: Array.from({ length: 33 }, () => sealed) }).success).toBe(false);
    });

    it('names the files the PR changed and removed, and the specs a retry is limited to', () => {
        const parsed = RuntimeSuiteRequestedSchema.parse({ ...pr, changedFiles: ['apps/web/a.ts'], removedFiles: ['cypress/e2e/old.cy.ts'], specs: ['cypress/e2e/a.cy.ts'] });
        expect(parsed).toMatchObject({ changedFiles: ['apps/web/a.ts'], removedFiles: ['cypress/e2e/old.cy.ts'], specs: ['cypress/e2e/a.cy.ts'] });
        expect(RuntimeSuiteRequestedSchema.safeParse({ ...pr, changedFiles: ['x'.repeat(513)] }).success).toBe(false);
    });

    it('a retry brings its own sealed tokens, since the product alone holds the credentials', () => {
        const base = { suiteRunId: pr.suiteRunId, organizationId: 'org-a', requestedBy: actor, requestedAt, key: 'k-retry', scope: 'failed' as const };
        expect(RuntimeSuiteRetriedSchema.safeParse({ ...base, repoToken: 'sealed:v1:abc', moreRepoTokens: ['sealed:v1:abc'] }).success).toBe(true);
        expect(RuntimeSuiteRetriedSchema.safeParse({ ...base, repoToken: 'ghs_plain' }).success).toBe(false);
    });
});

describe('the suite selection command', () => {
    const change = { organizationId: 'org-a', environmentId: 'env-1', selection: 'off' as const, requestedBy: actor, requestedAt, key: 'selection:1' };
    it('says on or off for one environment, and refuses anything else, an unknown key or a missing actor', () => {
        expect(() => runtimeCommandOutboxMessage(RuntimeCommandName.SuiteSelectionChanged, change, 'm-1')).not.toThrow();
        expect(() => runtimeCommandOutboxMessage(RuntimeCommandName.SuiteSelectionChanged, { ...change, selection: 'maybe' } as never, 'm-1')).toThrow();
        expect(() => runtimeCommandOutboxMessage(RuntimeCommandName.SuiteSelectionChanged, { ...change, extra: 1 } as never, 'm-1')).toThrow();
        const { requestedBy: _gone, ...noActor } = change;
        expect(() => runtimeCommandOutboxMessage(RuntimeCommandName.SuiteSelectionChanged, noActor as never, 'm-1')).toThrow();
    });
    it('is a control command, not work: it never waits behind the suites of the Run lane', () => {
        expect(isRunLaneEvent(RuntimeCommandName.SuiteSelectionChanged)).toBe(false);
    });
});
