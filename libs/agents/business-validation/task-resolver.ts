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
    if (!selected.length) {
        return { kind: 'no_reference', attempts };
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
        let missingFrom: TaskTracker[] = [];
        for (const tracker of capable) {
            const read = await tracker.read(reference, context);
            const lookup: typeof read =
                read.status === 'found' &&
                !matchesTitleHint(reference, read.task.title)
                    ? { status: 'not_found', tools: read.tools }
                    : read;
            attempts.push({
                reference: reference.raw,
                tracker: tracker.name,
                status: lookup.status,
                ...(lookup.status === 'error'
                    ? {
                          message: lookup.message,
                          ...(lookup.setup ? { setup: true } : {}),
                      }
                    : {}),
                ...(lookup.tools?.length ? { tools: lookup.tools } : {}),
            });
            if (lookup.status === 'found') {
                found.push({ reference, task: lookup.task });
                missingFrom = [];
                break;
            }
            // A tracker set up so it can't read a task is not one that can.
            readable ||= !(lookup.status === 'error' && lookup.setup);
            if (lookup.status === 'error') {
                failed ||= !lookup.setup;
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

/** Branch words that say what kind of change it is, not which task. */
const BRANCH_FILLER = new Set([
    'feat',
    'feature',
    'fix',
    'bugfix',
    'hotfix',
    'chore',
    'refactor',
    'issue',
    'task',
    'update',
    'from',
    'into',
    'remove',
    'change',
    'support',
    'with',
    'para',
]);

function words(text: string): string[] {
    return text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !BRANCH_FILLER.has(w));
}

/**
 * Whether an issue read for `fix/12-add-login` is the one the branch means:
 * its title shares a word with `add-login` (`login` ~ `Login page`,
 * `checkout` ~ `Checkouts`). Issue #404 "Dark mode" is not `fix/404-on-login`.
 */
export function matchesTitleHint(
    reference: TaskReference,
    title: string | undefined,
): boolean {
    if (reference.kind !== 'git_issue' || !reference.titleHint) {
        return true;
    }
    const hint = words(reference.titleHint);
    const inTitle = words(title ?? '');
    return hint.some((h) =>
        inTitle.some((t) => t.startsWith(h) || h.startsWith(t)),
    );
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

/**
 * The PR's repository as a tracker reads `#12` against: owner and bare name.
 * Some doors name it `owner/name`; the lookup then asked for
 * `owner/owner/name` and found nothing. The path's namespace wins over
 * `owner`, which GitLab fills with the group's display name ("Acme Corp").
 */
export function repositoryForLookup(repository: {
    name: string;
    owner?: string;
    fullName?: string;
}): { owner?: string; name: string } {
    const full = repository.name.includes('/')
        ? repository.name
        : (repository.fullName ?? '');
    const cut = full.lastIndexOf('/');
    return {
        owner: cut > 0 ? full.slice(0, cut) : repository.owner,
        name: repository.name.slice(repository.name.lastIndexOf('/') + 1),
    };
}
