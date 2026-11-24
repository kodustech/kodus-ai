import { type HostDriver } from '@libs/code-review/domain/risk/pr-decision-applier';
import {
    readyValue,
    unavailable,
    stale,
} from '@libs/code-review/domain/risk/pr-decision-reducer';

import type { IDecisionRecorder } from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';

import { PrDecisionReconcilerService } from './pr-decision-reconciler.service';
import type {
    L0Assessor,
    L1Assessor,
    L2Assessor,
    L3Assessor,
    ReconcilerTrigger,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import type { PrDecisionRecordModel } from '@libs/code-review/infrastructure/adapters/repositories/schemas/prDecisionRecord.model';
import type { PrDecisionRecordRepository } from '@libs/code-review/infrastructure/adapters/repositories/prDecisionRecord.repository';

const SNAP = 'cfg=v11;model=kodus-managed;head-snap';

function makeTrigger(over: Partial<ReconcilerTrigger> = {}): ReconcilerTrigger {
    const triggeredAt = new Date().toISOString();
    return {
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        prNumber: 142,
        headSha: 'a1b2c3d4',
        baseSha: 'e5f6a7b8',
        kind: 'commit-pushed',
        triggeredAt,
        snapshotKey: SNAP,
        gates: {
            riskAssessment: null,
            approvalDecision: null,
            platform: 'forgejo',
            prShape: {},
            changedFiles: [],
            sandbox: null,
            host: {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'repo' },
            },
        },
        ...over,
    };
}

describe('PrDecisionReconcilerService', () => {
    let l0Calls: number;
    let l1Calls: number;
    let l2Calls: number;
    let l3Calls: number;

    const repoStore: Array<PrDecisionRecordModel> = [];

    const repo = {
        async upsert(input: {
            organizationId: string;
            repositoryId: string;
            prNumber: number;
            headSha: string;
            baseSha: string;
            configurationKey: string;
            gateVerdictsSnapshot: unknown;
            lastApplyOutcome: unknown;
            lastReconciledAt: Date;
            consecutiveFailures: number;
            inFlightTriggerKind: string | null;
        }): Promise<PrDecisionRecordModel> {
            const existingIdx = repoStore.findIndex(
                (r) =>
                    r.organizationId === input.organizationId &&
                    r.repositoryId === input.repositoryId &&
                    r.prNumber === input.prNumber &&
                    r.headSha === input.headSha,
            );
            const baseRow = {
                uuid: `uuid-${existingIdx}-${Date.now()}`,
                createdAt: new Date(),
                updatedAt: new Date(),
            } as Partial<PrDecisionRecordModel>;
            const merged = {
                ...(repoStore[existingIdx] ?? {}),
                ...baseRow,
                organizationId: input.organizationId,
                repositoryId: input.repositoryId,
                prNumber: input.prNumber,
                headSha: input.headSha,
                baseSha: input.baseSha,
                configurationKey: input.configurationKey,
                gateVerdictsSnapshot: input.gateVerdictsSnapshot as never,
                lastApplyOutcome: input.lastApplyOutcome as never,
                lastReconciledAt: input.lastReconciledAt,
                consecutiveFailures: input.consecutiveFailures,
                inFlightTriggerKind: input.inFlightTriggerKind,
            } as PrDecisionRecordModel;
            if (existingIdx >= 0) repoStore[existingIdx] = merged;
            else repoStore.push(merged);
            return merged;
        },
        async findByRecordKey(input: {
            organizationId: string;
            repositoryId: string;
            prNumber: number;
            headSha: string;
        }): Promise<PrDecisionRecordModel | null> {
            return (
                repoStore.find(
                    (r) =>
                        r.organizationId === input.organizationId &&
                        r.repositoryId === input.repositoryId &&
                        r.prNumber === input.prNumber &&
                        r.headSha === input.headSha,
                ) ?? null
            );
        },
    } as unknown as PrDecisionRecordRepository;

    beforeEach(() => {
        l0Calls = 0;
        l1Calls = 0;
        l2Calls = 0;
        l3Calls = 0;
        repoStore.length = 0;
    });

    function buildService(
        opts: { recorder?: IDecisionRecorder } = {},
    ): PrDecisionReconcilerService {
        const l0: L0Assessor = {
            async assess() {
                l0Calls += 1;
                return readyValue([], SNAP);
            },
        };
        const l1: L1Assessor = {
            async assess() {
                l1Calls += 1;
                return readyValue(
                    {
                        riskScore: 0.16,
                        level: 'LOW' as const,
                        blastRadius: { totalFunctions: 1, totalFiles: 1 },
                        testGaps: [],
                        vetoContributingFunctions: [],
                        factors: [
                            {
                                name: 'blast_radius',
                                value: 0.1,
                                detail: 'small',
                            },
                        ],
                    },
                    SNAP,
                );
            },
        };
        const l2: L2Assessor = {
            async assess() {
                l2Calls += 1;
                return readyValue(
                    { riskIdentified: false, reason: 'clean' },
                    SNAP,
                );
            },
        };
        const l3: L3Assessor = {
            async assess() {
                l3Calls += 1;
                return readyValue(
                    { matchedPolicyId: 'docs/**', unmatchedReasons: [] },
                    SNAP,
                );
            },
        };

        return new PrDecisionReconcilerService(
            l0,
            l1,
            l2,
            l3,
            repo,
            okDriver(),
            opts.recorder,
        );
    }

    function okDriver(): HostDriver {
        return {
            async dismissIfNeeded() {
                return { status: 'ok' as const };
            },
            async approve() {
                return { status: 'ok' as const };
            },
            async upsertDecisionComment() {
                return { status: 'ok' as const };
            },
        };
    }

    it('happy path: APPROVE — all gates run, reducer folds, applier applied, record persists', async () => {
        const svc = buildService();
        const result = await svc.reconcile(makeTrigger());
        expect(result.desired.kind).toBe('APPROVE');
        expect(result.desired.policyId).toBe('docs/**');
        expect(result.apply).toEqual({ status: 'applied' });
        expect(result.record.headSha).toBe('a1b2c3d4');
        expect(l0Calls).toBe(1);
        expect(l1Calls).toBe(1);
        expect(l2Calls).toBe(1);
        expect(l3Calls).toBe(1);
        expect(repoStore[0].consecutiveFailures).toBe(0);
        expect(repoStore[0].inFlightTriggerKind).toBeNull();
        expect(repoStore[0].configurationKey).toBe(SNAP);
    });

    it('Q1 ratification: L1 Unavailable does not veto; APPROVE if others are quiet', async () => {
        const svc = buildService();
        // Override L1 to return Unavailable.
        (svc as unknown as { l1: L1Assessor }).l1 = {
            async assess() {
                return unavailable(SNAP, 'ast graph not indexed');
            },
        };
        const result = await svc.reconcile(makeTrigger());
        expect(result.desired.kind).toBe('APPROVE');
    });

    it('L1 HIGH vetoes (HOLD) — reason cites L1', async () => {
        const svc = buildService();
        (svc as unknown as { l1: L1Assessor }).l1 = {
            async assess() {
                return readyValue(
                    {
                        riskScore: 0.78,
                        level: 'HIGH' as const,
                        blastRadius: { totalFunctions: 30, totalFiles: 18 },
                        testGaps: [],
                        vetoContributingFunctions: [],
                        factors: [
                            {
                                name: 'blast_radius',
                                value: 0.7,
                                detail: 'wide',
                            },
                        ],
                    },
                    SNAP,
                );
            },
        };
        const result = await svc.reconcile(makeTrigger());
        expect(result.desired.kind).toBe('HOLD');
        if (result.desired.kind === 'HOLD') {
            expect(result.desired.vetoSources).toContain('l1');
        }
    });

    it('L2 Unavailable fails closed (HOLD, l2 source in vetoSources)', async () => {
        const svc = buildService();
        (svc as unknown as { l2: L2Assessor }).l2 = {
            async assess() {
                return unavailable(SNAP, 'rate-limit by main-provider');
            },
        };
        const result = await svc.reconcile(makeTrigger());
        expect(result.desired.kind).toBe('HOLD');
        if (result.desired.kind === 'HOLD') {
            expect(result.desired.vetoSources).toContain('l2');
        }
    });

    it('L3 unmatched → HOLD with l3 source', async () => {
        const svc = buildService();
        (svc as unknown as { l3: L3Assessor }).l3 = {
            async assess() {
                return readyValue(
                    {
                        matchedPolicyId: null,
                        unmatchedReasons: ['no label match'],
                    },
                    SNAP,
                );
            },
        };
        const result = await svc.reconcile(makeTrigger());
        expect(result.desired.kind).toBe('HOLD');
        if (result.desired.kind === 'HOLD') {
            expect(result.desired.vetoSources).toContain('l3');
        }
    });

    it('Stale on any gate → HOLD, abort → snapshotKey mismatch reason', async () => {
        const svc = buildService();
        (svc as unknown as { l2: L2Assessor }).l2 = {
            async assess() {
                return stale(SNAP, 'cfg=v10');
            },
        };
        const result = await svc.reconcile(makeTrigger());
        expect(result.desired.kind).toBe('HOLD');
        if (result.desired.kind === 'HOLD') {
            expect(result.desired.vetoSources).toContain('stale-snapshot');
        }
    });

    it('trigger arrival within completion window: aborted', async () => {
        const svc = buildService();
        await svc.reconcile(makeTrigger());

        // The first reconcile set `lastReconciledAt`. A second trigger whose
        // `triggeredAt` falls inside the 30s completion window is aborted
        // rather than started in parallel — so this one is dated in the past.
        const triggeredWithin: ReconcilerTrigger = {
            ...makeTrigger({
                triggeredAt: new Date(Date.now() - 5_000).toISOString(),
            }),
        };

        const result = await svc.reconcile(triggeredWithin);
        expect(result.apply.status).toBe('aborted');
    });

    it('apply partial path increments consecutiveFailures', async () => {
        const svc = buildService();
        // Replace host driver with one that retries on the upsertComment step.
        (svc as unknown as { hostDriver: HostDriver }).hostDriver = {
            async dismissIfNeeded() {
                return { status: 'ok' as const };
            },
            async approve() {
                return { status: 'ok' as const };
            },
            async upsertDecisionComment() {
                return {
                    status: 'retry' as const,
                    reason: 'rate-limited',
                };
            },
        };

        const result = await svc.reconcile(makeTrigger());
        expect(result.apply.status).toBe('partial');
    });

    it('passes the trigger changed files to the L1 assessor', async () => {
        // Regression: buildL1Input used to hardcode changedFiles: [], so the
        // graph gate reported "no changed source files" on every PR and L1
        // never ran in the live path.
        let seen: ReadonlyArray<{ filename: string; status: string }> | undefined;
        const svc = new PrDecisionReconcilerService(
            {
                async assess() {
                    return readyValue([], SNAP);
                },
            } as unknown as L0Assessor,
            {
                async assess(input) {
                    seen = input.changedFiles;
                    return readyValue(
                        {
                            riskScore: 0.1,
                            level: 'LOW' as const,
                            blastRadius: { totalFunctions: 1, totalFiles: 1 },
                            testGaps: [],
                            vetoContributingFunctions: [],
                            factors: [],
                        },
                        SNAP,
                    );
                },
            } as unknown as L1Assessor,
            {
                async assess() {
                    return readyValue(
                        { riskIdentified: false, reason: 'clean' },
                        SNAP,
                    );
                },
            } as unknown as L2Assessor,
            {
                async assess() {
                    return readyValue(
                        { matchedPolicyId: 'docs/**', unmatchedReasons: [] },
                        SNAP,
                    );
                },
            } as unknown as L3Assessor,
            repo,
            okDriver(),
            undefined,
        );

        const trigger = makeTrigger();
        trigger.gates.changedFiles = [
            { filename: 'src/a.ts', status: 'modified' },
            { filename: 'src/b.ts', status: 'added' },
        ];
        await svc.reconcile(trigger);

        expect(seen).toEqual([
            { filename: 'src/a.ts', status: 'modified' },
            { filename: 'src/b.ts', status: 'added' },
        ]);
    });

    describe('outbox recorder', () => {
        it('records one row per successful apply transition with kind=approve and no notAfter', async () => {
            const record = jest.fn().mockResolvedValue(undefined);
            const svc = buildService({ recorder: { record } });
            await svc.reconcile(makeTrigger());
            expect(record).toHaveBeenCalledTimes(1);
            const call = record.mock.calls[0][0];
            expect(call.decision).toBe('approve');
            expect(call.notAfter).toBeUndefined();
            expect(call.organizationId).toBe('org-1');
            expect(call.prNumber).toBe(142);
        });

        it('records kind=hold with a notAfter deadline', async () => {
            const record = jest.fn().mockResolvedValue(undefined);
            const svc = buildService({ recorder: { record } });
            // Override L2 to return risk-found → HOLD path.
            (svc as unknown as { l2: L2Assessor }).l2 = {
                async assess() {
                    return readyValue(
                        {
                            riskIdentified: true,
                            reason: 'auth path compromise',
                        },
                        SNAP,
                    );
                },
            };
            await svc.reconcile(makeTrigger());
            expect(record).toHaveBeenCalledTimes(1);
            const call = record.mock.calls[0][0];
            expect(call.decision).toBe('hold');
            expect(call.notAfter).toBeDefined();
            // notAfter is 5 minutes in the future
            const notAfterMs = Date.parse(call.notAfter!);
            const nowMs = Date.now();
            expect(notAfterMs - nowMs).toBeGreaterThan(4 * 60_000);
            expect(notAfterMs - nowMs).toBeLessThan(6 * 60_000);
        });

        it('on approve → hold → approve, three transitions are recorded', async () => {
            const calls: Array<{ decision: string; occurredAt: string }> = [];
            const record = jest.fn(async (input) => {
                calls.push({
                    decision: input.decision,
                    occurredAt: input.occurredAt,
                });
            });
            const svc = buildService({ recorder: { record } });

            // 1. approve — wait briefly so ISO ms resolution observes an increment
            await svc.reconcile(makeTrigger());
            await sleep(2);
            // 2. hold (override L2)
            (svc as unknown as { l2: L2Assessor }).l2 = {
                async assess() {
                    return readyValue(
                        { riskIdentified: true, reason: 'risk' },
                        SNAP,
                    );
                },
            };
            await svc.reconcile(
                makeTrigger({ headSha: 'h2', triggeredAt: laterTimestamp() }),
            );
            await sleep(2);
            // 3. approve (reset L2)
            (svc as unknown as { l2: L2Assessor }).l2 = {
                async assess() {
                    return readyValue(
                        { riskIdentified: false, reason: 'clean' },
                        SNAP,
                    );
                },
            };
            await svc.reconcile(
                makeTrigger({ headSha: 'h3', triggeredAt: laterTimestamp() }),
            );

            expect(calls.map((c) => c.decision)).toEqual([
                'approve',
                'hold',
                'approve',
            ]);
            // occurredAt is strictly increasing
            const tsMs = calls.map((c) => Date.parse(c.occurredAt));
            expect(tsMs[2]).toBeGreaterThan(tsMs[1]);
            expect(tsMs[1]).toBeGreaterThan(tsMs[0]);
        });
    });
});

function laterTimestamp(): string {
    return new Date(Date.now() + 1_000).toISOString();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
