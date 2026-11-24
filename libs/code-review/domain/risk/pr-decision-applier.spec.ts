import { readyValue, reduce } from './pr-decision-reducer';
import {
    applyDesiredHostState,
    type HostDriver,
    type HostCallResult,
    type PrRecordInput,
} from './pr-decision-applier';

const SNAP = 'cfg=v11;model=kodus-managed;head=test';

function ok(): HostCallResult {
    return { status: 'ok' };
}
function retry(reason: string): HostCallResult {
    return { status: 'retry', reason };
}

function mockDriver(responses: HostCallResult[]): HostDriver & {
    calls: Array<{ method: string; payload?: unknown }>;
} {
    const calls: Array<{ method: string; payload?: unknown }> = [];
    let idx = 0;
    const next = (): HostCallResult =>
        responses[Math.min(idx++, responses.length - 1)] ?? ok();
    return {
        calls,
        async dismissIfNeeded() {
            calls.push({ method: 'dismissIfNeeded' });
            return next();
        },
        async approve() {
            calls.push({ method: 'approve' });
            return next();
        },
        async upsertDecisionComment(_hr, comment) {
            calls.push({ method: 'upsertDecisionComment', payload: comment });
            return next();
        },
    };
}

const approvedReduced = () =>
    reduce({
        snapshotKey: SNAP,
        l0: readyValue<[]>([], SNAP),
        l1: readyValue(
            {
                riskScore: 0.16,
                level: 'LOW' as const,
                blastRadius: { totalFunctions: 1, totalFiles: 1 },
                testGaps: [],
                vetoContributingFunctions: [],
                factors: [{ name: 'blast_radius', value: 0.1, detail: '' }],
            },
            SNAP,
        ),
        l2: readyValue({ riskIdentified: false, reason: 'clean' }, SNAP),
        l3: readyValue(
            { matchedPolicyId: 'docs/**', unmatchedReasons: [] },
            SNAP,
        ),
    });

const heldReduced = () =>
    reduce({
        snapshotKey: SNAP,
        l0: readyValue<[]>([], SNAP),
        l1: readyValue(
            {
                riskScore: 0.78,
                level: 'HIGH' as const,
                blastRadius: { totalFunctions: 30, totalFiles: 18 },
                testGaps: [],
                vetoContributingFunctions: [],
                factors: [{ name: 'blast_radius', value: 0.7, detail: 'wide' }],
            },
            SNAP,
        ),
        l2: readyValue({ riskIdentified: false, reason: 'clean' }, SNAP),
        l3: readyValue(
            { matchedPolicyId: 'docs/**', unmatchedReasons: [] },
            SNAP,
        ),
    });

function record(over: Partial<PrRecordInput> = {}): PrRecordInput {
    return {
        repoId: 'repo-1',
        prNumber: 142,
        headSha: 'a1b2',
        snapshotKey: SNAP,
        priorChangeRequestActive: false,
        host: {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'repo' },
        },
        ...over,
    };
}

describe('applyDesiredHostState', () => {
    it('APPROVE: no prior change request runs approve + upsertComment (no dismiss)', async () => {
        const driver = mockDriver([ok(), ok()]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record(),
            driver,
        );
        expect(r.kind).toBe('applied');
        expect(driver.calls.map((c) => c.method)).toEqual([
            'approve',
            'upsertDecisionComment',
        ]);
        expect(r.comment?.kind).toBe('approve');
    });

    it('APPROVE: prior REQUEST_CHANGES triggers dismiss then approve then upsertComment', async () => {
        const driver = mockDriver([ok(), ok(), ok()]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record({ priorChangeRequestActive: true }),
            driver,
        );
        expect(r.kind).toBe('applied');
        expect(driver.calls.map((c) => c.method)).toEqual([
            'dismissIfNeeded',
            'approve',
            'upsertDecisionComment',
        ]);
    });

    it('HOLD: only upsertComment (no dismiss, no approve)', async () => {
        const driver = mockDriver([ok()]);
        const r = await applyDesiredHostState(heldReduced(), record(), driver);
        expect(r.kind).toBe('applied');
        expect(driver.calls.map((c) => c.method)).toEqual([
            'upsertDecisionComment',
        ]);
        expect(r.comment?.kind).toBe('hold');
        expect(r.comment?.reason).toContain('HIGH');
    });

    it('dismiss retry halts the sequence; no approve after', async () => {
        const driver = mockDriver([retry('rate-limited'), ok(), ok()]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record({ priorChangeRequestActive: true }),
            driver,
        );
        expect(r.kind).toBe('partial');
        expect(driver.calls.map((c) => c.method)).toEqual(['dismissIfNeeded']);
        expect(r.comment).toBeUndefined(); // never reached step 3
    });

    it('approve retry halts AFTER attempted approve; comment shape preserved', async () => {
        const driver = mockDriver([retry('rate-limited')]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record(),
            driver,
        );
        expect(r.kind).toBe('partial');
        // Step sequence: approve (no dismiss because prior not active), then halt.
        expect(driver.calls.map((c) => c.method)).toEqual(['approve']);
        // comment was composed but wait — the implementation composes comment
        // before step 3 (so the reconciler can record it for retry). Verify.
        expect(r.comment?.kind).toBe('approve');
    });

    it('upsertComment retry halts AFTER attempted comment; outcome partial', async () => {
        // approve succeeds so the sequence reaches step 3; then upsertComment
        // returns retry, which the applier records as the failing step.
        const driver = mockDriver([ok(), retry('rate-limited')]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record(),
            driver,
        );
        expect(r.kind).toBe('partial');
        expect(driver.calls.map((c) => c.method)).toEqual([
            'approve',
            'upsertDecisionComment',
        ]);
    });

    it('a fatal result on dismiss halts the sequence; outcome partial', async () => {
        const driver = mockDriver([
            { status: 'fatal', reason: 'auth' } as HostCallResult,
        ]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record({ priorChangeRequestActive: true }),
            driver,
        );
        expect(r.kind).toBe('partial');
        expect(driver.calls.map((c) => c.method)).toEqual(['dismissIfNeeded']);
    });

    it('idempotency: rerunning after a partial outcome is safe (state reflects retry cycle)', async () => {
        // First run: dismiss succeeds; retry on approve.
        const driver1 = mockDriver([ok(), retry('rate-limited'), ok()]);
        const r1 = await applyDesiredHostState(
            approvedReduced(),
            record({ priorChangeRequestActive: true }),
            driver1,
        );
        expect(r1.kind).toBe('partial');

        // Reconstruction: the prior REQUEST_CHANGES is already closed after
        // dismiss succeeded. The second run re-reads host state and the
        // priorChangeRequestActive flag is now false.
        const driver2 = mockDriver([ok(), ok()]);
        const r2 = await applyDesiredHostState(
            approvedReduced(),
            record({ priorChangeRequestActive: false }),
            driver2,
        );
        expect(r2.kind).toBe('applied');
    });

    it('produces an approve comment when desired is APPROVE', async () => {
        const driver = mockDriver([ok(), ok()]);
        const r = await applyDesiredHostState(
            approvedReduced(),
            record(),
            driver,
        );
        expect(r.comment?.kind).toBe('approve');
        expect(r.comment?.reason).toContain("Policy 'docs/**'");
    });
});
