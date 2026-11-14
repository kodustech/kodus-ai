import { z } from 'zod';
import type { Clock, RunProjectionReader } from '../domain/ports';
import type {
    ExternalFindingsStore,
    ExternalSubmissionRecord,
    ExternalTaskView,
} from '../domain/external-findings';
import { isTerminal, type ProbeVerdict } from '@libs/runtime/run/run-state';

const finishedAtSchema = z.string().max(64).datetime({ offset: true });

function measuredVerdict(
    findingId: string,
    proof: ProbeVerdict | undefined,
): Record<string, unknown> {
    const base = proof?.baseStepIds ?? [];
    const pr = proof?.prStepIds ?? [];
    const bothSides =
        new Set(base).size >= 2 &&
        new Set(pr).size >= 1 &&
        !base.some((id) => pr.includes(id));
    const finding =
        proof?.verdict === 'finding' && bothSides && new Set(pr).size >= 2;
    const verdict = finding
        ? 'finding'
        : proof?.verdict === 'finding'
          ? 'inconclusive'
          : proof &&
              (bothSides ||
                  ['blocker', 'inconclusive', 'unverified'].includes(
                      proof.verdict,
                  ))
            ? proof.verdict
            : 'unverified';
    return {
        findingId,
        verdict,
        verification: finding ? 'verified_by_execution' : 'not_verified',
        ...(bothSides ? { baseStepIds: base, prStepIds: pr } : {}),
    };
}

/** Same exact proof decision for API reads and product maintenance; never starts work. */
export class ExternalVerificationReconciler {
    constructor(
        private readonly store: Pick<
            ExternalFindingsStore,
            'byTask' | 'complete'
        >,
        private readonly runs: RunProjectionReader,
        private readonly now: Clock,
    ) {}
    /** Internal product maintenance: no execution, permission expansion or Runtime writes. */
    async reconcileTask(
        organizationId: string,
        taskId: string,
        signal?: AbortSignal,
    ) {
        signal?.throwIfAborted();
        const record = await this.store.byTask(organizationId, taskId);
        if (!record) return 'missing' as const;
        return (await this.reconcile(record, signal)).state;
    }

    private async readProjection(
        record: ExternalSubmissionRecord,
        parent?: AbortSignal,
    ) {
        parent?.throwIfAborted();
        const controller = new AbortController();
        const abort = () =>
            controller.abort(new Error('Projection read cancelled'));
        parent?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await new Promise<
                Awaited<ReturnType<RunProjectionReader['get']>>
            >((resolve, reject) => {
                controller.signal.addEventListener(
                    'abort',
                    () => reject(new Error('Projection read unavailable')),
                    { once: true },
                );
                timer = setTimeout(
                    () =>
                        controller.abort(
                            new Error('Projection read timed out'),
                        ),
                    1500,
                );
                // The real adapter propagates CSOT/server maxTimeMS and AbortSignal;
                // the outer deadline also bounds connection initialization/fake ports.
                this.runs
                    .get(
                        record.runId!,
                        { organizationId: record.organizationId },
                        {
                            timeoutMs: 1500,
                            signal: controller.signal,
                            view: 'external_verification',
                        },
                    )
                    .then(resolve, reject);
            });
        } catch {
            parent?.throwIfAborted();
            return null;
        } finally {
            if (timer) clearTimeout(timer);
            parent?.removeEventListener('abort', abort);
        }
    }

    async reconcile(
        record: ExternalSubmissionRecord,
        signal?: AbortSignal,
    ): Promise<ExternalTaskView> {
        const base = {
            id: record.verificationTaskId,
            contextId: record.receiptId,
            createdAt: record.createdAt,
        };
        if (record.refusal)
            return {
                ...base,
                state: 'rejected',
                result: {
                    reason: record.refusal,
                    verdicts: record.findingIds.map((findingId) => ({
                        findingId,
                        verdict: 'unverified',
                        verification: 'not_verified',
                    })),
                },
                updatedAt: record.createdAt,
            };
        if (record.terminal) return { ...base, ...record.terminal };
        const run = record.runId
            ? await this.readProjection(record, signal)
            : null;
        signal?.throwIfAborted();
        const at = this.now().toISOString();
        const expired = Date.parse(at) >= Date.parse(record.expiresAt);
        const timestamp = finishedAtSchema.safeParse(run?.finishedAt);
        const finishedAt = timestamp.success ? Date.parse(timestamp.data) : NaN;
        const eligibleLateProof =
            !!run &&
            isTerminal(run.state) &&
            Number.isFinite(finishedAt) &&
            finishedAt >= Date.parse(record.createdAt) &&
            finishedAt <= Date.parse(record.expiresAt);
        let terminal: ExternalSubmissionRecord['terminal'];
        if (
            run &&
            (run.runId !== record.runId ||
                run.organizationId !== record.organizationId ||
                run.teamId !== record.teamId ||
                run.repositoryId !== record.repositoryId ||
                run.prNumber !== record.prNumber ||
                run.headSha !== record.headSha ||
                run.imageId !== record.imageId)
        ) {
            terminal = {
                state: 'failed',
                result: { reason: 'verification_binding_mismatch' },
                updatedAt: at,
            };
        } else if (expired && !eligibleLateProof) {
            terminal = {
                state: 'failed',
                result: { reason: 'verification_deadline_exceeded' },
                updatedAt: at,
            };
        } else if (run && isTerminal(run.state)) {
            const proofStates = [
                'regression',
                'no_regressions',
                'partly_tested',
            ];
            terminal = proofStates.includes(run.state)
                ? {
                      state: 'completed',
                      result: {
                          runId: record.runId,
                          source: record.submission.source,
                          verdicts: record.findingIds.map((findingId) =>
                              measuredVerdict(
                                  findingId,
                                  run.probes?.find(
                                      (p) => p.probeId === findingId,
                                  ),
                              ),
                          ),
                      },
                      updatedAt: at,
                  }
                : {
                      state: 'failed',
                      result: {
                          reason: 'verification_run_did_not_finish',
                          runState: run.state,
                      },
                      updatedAt: at,
                  };
        }
        if (terminal) {
            const completed = await this.store.complete(
                record.organizationId,
                record.verificationTaskId,
                terminal,
            );
            return { ...base, ...completed.terminal! };
        }
        return {
            ...base,
            state: 'working',
            result: { runId: record.runId },
            updatedAt: at,
        };
    }
}
