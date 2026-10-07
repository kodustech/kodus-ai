import type {
    FoundTask,
    ResolutionAttempt,
    TaskReference,
    TaskResolution,
} from './business-validation.types';
import { selectReferences } from './task-references';
import type { TaskTracker, TrackerReadContext } from './trackers/tracker';

/** A PR that states more tasks than this is a release or a merge, not one task's work. */
export const MAX_REFERENCES = 3;

/**
 * Every task the PR states that a connected tracker confirms, asked in
 * reference order and, per reference, in connection order. Nothing is
 * guessed: a reference no tracker confirms is dropped, and the outcome says
 * why.
 */
export async function resolveTasks(
    references: TaskReference[],
    trackers: TaskTracker[],
    context: TrackerReadContext,
): Promise<TaskResolution> {
    const attempts: ResolutionAttempt[] = [];
    if (!references.length) {
        return { kind: 'no_reference', attempts };
    }
    const selected = selectReferences(references, MAX_REFERENCES);
    if (!selected) {
        return { kind: 'too_many_references', attempts };
    }
    if (!trackers.length) {
        return { kind: 'no_tracker', attempts };
    }

    const found: FoundTask[] = [];
    let readable = false;
    let failed = false;
    let looksIntended = false;
    let intended:
        { reference: TaskReference; tracker: TaskTracker } | undefined;
    for (const reference of selected) {
        const capable = trackers.filter((t) => t.canRead(reference));
        readable ||= capable.length > 0;
        let missingFrom: TaskTracker[] = [];
        for (const tracker of capable) {
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
                found.push({ reference, task: lookup.task });
                missingFrom = [];
                break;
            }
            if (lookup.status === 'error') {
                failed = true;
            } else {
                missingFrom.push(tracker);
            }
        }
        // `SAA-999` where SAA is a Linear team is a typo worth telling the
        // author about; `UTF-8` is not (UC-14, UC-21).
        for (const tracker of missingFrom) {
            if (looksIntended) {
                break;
            }
            looksIntended =
                (await tracker.ownsReference?.(reference, context)) ?? false;
            if (looksIntended) {
                intended = { reference, tracker };
            }
        }
    }

    if (found.length) {
        return { kind: 'found', tasks: found, attempts };
    }
    if (!readable) {
        return { kind: 'no_capable_tracker', attempts };
    }
    if (failed) {
        return { kind: 'tracker_unavailable', attempts };
    }
    return {
        kind: 'not_found',
        looksIntended,
        ...(intended
            ? {
                  intended: {
                      reference: intended.reference,
                      tracker: intended.tracker.name,
                      nearby: await nearbyTasks(
                          intended.reference,
                          intended.tracker,
                          context,
                      ),
                  },
              }
            : {}),
        attempts,
    };
}

const MAX_NEARBY_READS = 4;

/**
 * Real tasks one typo away from a key that doesn't exist (`SAA-999` →
 * `SAA-99`, `SAA-199`). Each is read by its id, like any reference.
 */
async function nearbyTasks(
    reference: TaskReference,
    tracker: TaskTracker,
    context: TrackerReadContext,
): Promise<string[]> {
    if (reference.kind !== 'key') {
        return [];
    }
    const [prefix, digits] = reference.id.split('-');
    const candidates = new Set<string>();
    for (let i = 0; i < digits.length && digits.length > 1; i++) {
        candidates.add(digits.slice(0, i) + digits.slice(i + 1));
    }
    for (let i = 0; i + 1 < digits.length; i++) {
        candidates.add(
            digits.slice(0, i) +
                digits[i + 1] +
                digits[i] +
                digits.slice(i + 2),
        );
    }
    const number = Number(digits);
    candidates.add(String(number - 1));
    candidates.add(String(number + 1));
    candidates.delete(digits);

    const nearby: string[] = [];
    for (const candidate of [...candidates]
        .filter((c) => /^[1-9]\d*$/.test(c))
        .slice(0, MAX_NEARBY_READS)) {
        const id = `${prefix}-${candidate}`;
        const lookup = await tracker.read(
            { ...reference, id, raw: id },
            context,
        );
        if (lookup.status === 'found') {
            nearby.push(id);
        }
    }
    return nearby;
}
