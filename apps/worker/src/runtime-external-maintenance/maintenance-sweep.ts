import type { ExternalFindingsStore } from '@libs/runtime/api/domain/external-findings';
import type { ExternalVerificationReconciler } from '@libs/runtime/api/application/external-verification-reconciler';
import type {
    ExternalMaintenanceCandidates,
    MaintenanceCandidateKind,
} from './maintenance-candidates';

export interface ExternalMaintenanceLimits {
    maxTasks: number;
    candidateWindow: number;
    retentionDays: number;
}
export interface ExternalMaintenanceSummary {
    reconciled: number;
    completed: number;
    failed: number;
    rejected: number;
    missing: number;
    working: number;
    purged: number;
    errors: number;
    budgetStopped: boolean;
}

/** Bounded assistance, not continuous polling: overdue tasks and old terminal records only. */
export class ExternalMaintenanceSweep {
    private readonly cursors: Partial<
        Record<MaintenanceCandidateKind, string>
    > = {};
    constructor(
        private readonly candidates: Pick<
            ExternalMaintenanceCandidates,
            'page'
        >,
        private readonly store: Pick<
            ExternalFindingsStore,
            'listExpiredTaskIds' | 'purgeTerminal'
        >,
        private readonly reconciler: Pick<
            ExternalVerificationReconciler,
            'reconcileTask'
        >,
        private readonly now: () => Date,
        private readonly limits: ExternalMaintenanceLimits,
    ) {
        if (
            !Number.isInteger(limits.maxTasks) ||
            limits.maxTasks < 1 ||
            limits.maxTasks > 100 ||
            !Number.isInteger(limits.candidateWindow) ||
            limits.candidateWindow < 1 ||
            limits.candidateWindow > 500 ||
            !Number.isInteger(limits.retentionDays) ||
            limits.retentionDays < 30 ||
            limits.retentionDays > 365
        )
            throw new RangeError('Invalid external maintenance limits');
    }
    async run(signal: AbortSignal): Promise<ExternalMaintenanceSummary> {
        const out: ExternalMaintenanceSummary = {
            reconciled: 0,
            completed: 0,
            failed: 0,
            rejected: 0,
            missing: 0,
            working: 0,
            purged: 0,
            errors: 0,
            budgetStopped: false,
        };
        const at = this.now().toISOString();
        const cutoff = new Date(
            Date.parse(at) - this.limits.retentionDays * 86400_000,
        ).toISOString();
        for (const kind of ['expired', 'terminal'] as const) {
            if (signal.aborted) {
                out.budgetStopped = true;
                break;
            }
            try {
                const page = await this.candidates.page(
                    kind,
                    kind === 'expired' ? at : cutoff,
                    this.cursors[kind],
                    this.limits.candidateWindow,
                );
                // Advance across protected/unavailable candidates too; no oldest-page starvation.
                this.cursors[kind] = page.cursor;
                for (const org of page.organizationIds) {
                    if (signal.aborted) {
                        out.budgetStopped = true;
                        break;
                    }
                    try {
                        if (kind === 'terminal') {
                            if (out.purged >= this.limits.maxTasks) break;
                            out.purged += await this.store.purgeTerminal(
                                org,
                                cutoff,
                                this.limits.maxTasks - out.purged,
                            );
                        } else {
                            if (out.reconciled >= this.limits.maxTasks) break;
                            const ids = await this.store.listExpiredTaskIds(
                                org,
                                at,
                                this.limits.maxTasks - out.reconciled,
                            );
                            for (const id of ids) {
                                if (signal.aborted) {
                                    out.budgetStopped = true;
                                    break;
                                }
                                out.reconciled++;
                                try {
                                    out[
                                        await this.reconciler.reconcileTask(
                                            org,
                                            id,
                                            signal,
                                        )
                                    ]++;
                                } catch {
                                    if (signal.aborted)
                                        out.budgetStopped = true;
                                    else out.errors++;
                                }
                                if (out.reconciled >= this.limits.maxTasks)
                                    break;
                            }
                        }
                    } catch {
                        if (signal.aborted) out.budgetStopped = true;
                        else out.errors++;
                    }
                }
            } catch {
                if (signal.aborted) out.budgetStopped = true;
                else out.errors++;
            }
        }
        return out;
    }
}
