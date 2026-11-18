/**
 * Enterprise Code — see `license_ee.md`. Runs the heavy review on each Ultra
 * model, with one fallback for the whole review.
 */
import type {
    UltraModel,
    UltraReviewState,
    UltraRunOutcome,
} from '@libs/code-review/domain/ultra-review-state';

/** What one model's heavy run returned. */
export interface UltraModelRunResult<T> {
    /** The generalist finished: no error, not cut short, verify judged all. */
    completed: boolean;
    failureReason?: string;
    /** What the run produced, complete or partial. Absent when it threw. */
    output?: T;
    findings?: number;
}

/** A run's output the merge takes, with the model that produced it. */
export interface UltraRunOutput<T> {
    model: UltraModel;
    output: T;
    completed: boolean;
}

/**
 * Runs `run` on each available model in parallel. The org fallback runs at
 * most once, in place of the first model that fails (a model the config no
 * longer resolves fails before it starts), as soon as it fails; the other
 * failed models are not replaced. A fallback that is one of the three never
 * runs again: the first other model to fail is marked as replaced by its
 * review. A failed model replaced by a fallback that completed gives up its
 * partial output; with no fallback, or a failed one, the partial output stays.
 * `run` must not throw; a throw is read as a failed run with no output.
 */
export async function runUltraModels<T>(input: {
    state: Pick<UltraReviewState, 'models' | 'unavailable' | 'fallback'>;
    run: (model: UltraModel) => Promise<UltraModelRunResult<T>>;
    now?: () => number;
}): Promise<{ runs: UltraRunOutcome[]; outputs: UltraRunOutput<T>[] }> {
    const now = input.now ?? Date.now;
    const { models, fallback } = input.state;
    const fallbackInTrio =
        !!fallback && models.some((m) => m.modelId === fallback.modelId);

    const outcomes: UltraRunOutcome[] = [];
    const outputs = new Map<UltraRunOutcome, UltraRunOutput<T>>();
    let fallbackUsed = false;
    let fallbackRun: Promise<void> | undefined;

    const execute = async (model: UltraModel): Promise<UltraRunOutcome> => {
        const startedAt = now();
        let result: UltraModelRunResult<T>;
        try {
            result = await input.run(model);
        } catch (error) {
            result = {
                completed: false,
                failureReason:
                    error instanceof Error ? error.message : String(error),
            };
        }
        const outcome: UltraRunOutcome = {
            position: model.position,
            modelId: model.modelId,
            modelName: model.modelName,
            status: result.completed ? 'completed' : 'failed',
            ...(!result.completed && {
                failureReason:
                    result.failureReason ?? 'The review did not complete.',
            }),
            ...(result.findings !== undefined && { findings: result.findings }),
            durationMs: now() - startedAt,
        };
        outcomes.push(outcome);
        if (result.output !== undefined) {
            outputs.set(outcome, {
                model,
                output: result.output,
                completed: result.completed,
            });
        }
        return outcome;
    };

    /** The first failure of a model takes the fallback, if there is one. */
    const onFailure = (failed: UltraRunOutcome | { modelId: string }) => {
        if (fallbackUsed || !fallback) return;
        if (fallbackInTrio) {
            // Its own failure leaves nothing to reuse.
            if (failed.modelId === fallback.modelId) return;
            fallbackUsed = true;
            if ('status' in failed) {
                failed.replacedBy = fallback.modelId;
                failed.reusedRun = true;
            } else {
                pendingReplacement.set(failed.modelId, {
                    replacedBy: fallback.modelId,
                    reusedRun: true,
                });
            }
            return;
        }
        fallbackUsed = true;
        if ('status' in failed) {
            failed.replacedBy = fallback.modelId;
        } else {
            pendingReplacement.set(failed.modelId, {
                replacedBy: fallback.modelId,
            });
        }
        fallbackRun = execute(fallback).then(() => undefined);
    };

    // A model the config no longer resolves fails before anything runs.
    const pendingReplacement = new Map<
        string,
        Pick<UltraRunOutcome, 'replacedBy' | 'reusedRun'>
    >();
    for (const missing of input.state.unavailable ?? []) {
        onFailure({ modelId: missing.modelId });
    }

    await Promise.all(
        models.map(async (model) => {
            const outcome = await execute(model);
            if (outcome.status === 'failed') onFailure(outcome);
        }),
    );
    await fallbackRun;

    // A missing model's outcome, so the notice and the screen list it.
    for (const missing of input.state.unavailable ?? []) {
        outcomes.push({
            position: missing.position,
            modelId: missing.modelId,
            modelName: missing.modelId,
            status: 'failed',
            failureReason: missing.reason,
            ...pendingReplacement.get(missing.modelId),
        });
    }

    const completedIds = new Set(
        outcomes.filter((o) => o.status === 'completed').map((o) => o.modelId),
    );
    const kept: UltraRunOutput<T>[] = [];
    for (const [outcome, out] of outputs) {
        const replacedByCompleted =
            outcome.status === 'failed' &&
            !!outcome.replacedBy &&
            completedIds.has(outcome.replacedBy);
        if (!replacedByCompleted) kept.push(out);
    }

    const order = (o: UltraRunOutcome) =>
        o.position === 'fallback' ? 4 : o.position;
    outcomes.sort((a, b) => order(a) - order(b));
    kept.sort((a, b) => {
        const pa = a.model.position === 'fallback' ? 4 : a.model.position;
        const pb = b.model.position === 'fallback' ? 4 : b.model.position;
        return pa - pb;
    });
    return { runs: outcomes, outputs: kept };
}

/**
 * Success: three distinct models completed and the merge succeeded (on the
 * merge model or the fallback). Degraded: at least one completed otherwise.
 * Failed: none completed.
 */
export function ultraReviewOutcome(
    runs: UltraRunOutcome[],
    merge: UltraReviewState['merge'],
): NonNullable<UltraReviewState['outcome']> {
    const completed = new Set(
        runs.filter((r) => r.status === 'completed').map((r) => r.modelId),
    ).size;
    if (completed === 0) return 'failed';
    const merged = merge?.status === 'success' || merge?.status === 'fallback';
    return completed >= 3 && merged ? 'success' : 'degraded';
}
