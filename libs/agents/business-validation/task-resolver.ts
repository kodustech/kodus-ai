import type {
    ResolutionAttempt,
    TaskReference,
    TaskResolution,
} from './business-validation.types';
import type { TaskTracker, TrackerReadContext } from './trackers/tracker';

/** A PR that names more tasks than this is a release or a merge, not one task's work. */
const MAX_REFERENCES = 3;

/**
 * The first reference a connected tracker confirms, asked in reference order
 * and, per reference, in connection order. Nothing is guessed: a reference no
 * tracker confirms is dropped, and the outcome says why.
 */
export async function resolveTask(
    references: TaskReference[],
    trackers: TaskTracker[],
    context: TrackerReadContext,
): Promise<TaskResolution> {
    const attempts: ResolutionAttempt[] = [];
    if (!references.length) {
        return { kind: 'no_reference', attempts };
    }
    if (!trackers.length) {
        return { kind: 'no_tracker', attempts };
    }

    let readable = false;
    let failed = false;
    for (const reference of references.slice(0, MAX_REFERENCES)) {
        for (const tracker of trackers.filter((t) => t.canRead(reference))) {
            readable = true;
            const lookup = await tracker.read(reference, context);
            attempts.push({
                reference: reference.raw,
                tracker: tracker.name,
                status: lookup.status,
                ...(lookup.status === 'error'
                    ? { message: lookup.message }
                    : {}),
            });
            if (lookup.status === 'found') {
                return {
                    kind: 'found',
                    reference,
                    task: lookup.task,
                    attempts,
                };
            }
            failed ||= lookup.status === 'error';
        }
    }

    if (!readable) {
        return { kind: 'no_capable_tracker', attempts };
    }
    return { kind: failed ? 'tracker_unavailable' : 'not_found', attempts };
}
