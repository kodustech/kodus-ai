import type { RequirementTopic } from '../judge/validation.types';
import type { ValidationRunRecord } from './validation-run.repository';

/** Skip reasons that mean "we couldn't read a task", as the card counts them. */
const COULDNT_READ = new Set([
    'task_not_found',
    'tracker_unavailable',
    'no_capable_tracker',
    'task_too_thin',
    'task_missing',
]);

export interface BusinessLogicStatus {
    /** `paused` when the task source stopped answering and hasn't answered since (UC-06). */
    state: 'working' | 'paused' | 'idle';
    lastTaskRead?: { id: string; tracker: string; at: string };
    paused?: { tracker: string; since: string; uncheckedPullRequests: number };
    stats: {
        pullRequestsChecked: number;
        /** Share of checked PRs whose last verdict passed. */
        metRate?: number;
        /** Share of flagged requirements nobody waived or overturned. */
        agreedRate?: number;
        couldntRead: number;
        couldntReadByReason: Record<string, number>;
    };
    /** PRs that referenced a kind of task no connected tracker reads (UC-07). */
    pointsElsewhere?: { pullRequests: number; kind: string };
}

type PrKey = string;

function prKey(run: ValidationRunRecord): PrKey | undefined {
    return run.pullRequestNumber !== undefined && run.repositoryId
        ? `${run.repositoryId}#${run.pullRequestNumber}`
        : undefined;
}

/** The latest run per PR, from runs sorted newest first. */
function latestPerPr(runs: ValidationRunRecord[]): ValidationRunRecord[] {
    const seen = new Set<PrKey>();
    const latest: ValidationRunRecord[] = [];
    for (const run of runs) {
        const key = prKey(run);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        latest.push(run);
    }
    return latest;
}

/** The settings card: is it working, and what happened over the window. Runs newest first. */
export function summarizeStatus(
    runs: ValidationRunRecord[],
): BusinessLogicStatus {
    const prRuns = runs.filter((r) => prKey(r));
    const latest = latestPerPr(prRuns);
    const validated = latest.filter((r) => r.outcome === 'validated');

    const lastRead = runs.find((r) => r.tasks?.length);
    const lastUnavailable = runs.find(
        (r) =>
            r.outcome === 'skipped' && r.skipReason === 'tracker_unavailable',
    );
    const lastAnswered = runs.find(
        (r) =>
            r.outcome !== 'skipped' ||
            (r.skipReason !== 'tracker_unavailable' &&
                (r.attempts ?? []).some((a) => a.status !== 'error')),
    );
    const paused =
        lastUnavailable &&
        (!lastAnswered || lastAnswered.createdAt < lastUnavailable.createdAt);
    const pausedSince = paused
        ? oldestUnavailableStreak(runs, lastAnswered?.createdAt)
        : undefined;

    const couldntReadByReason: Record<string, number> = {};
    for (const run of latest) {
        const reason = run.outcome === 'skipped' ? run.skipReason : run.outcome;
        if (reason && COULDNT_READ.has(reason)) {
            couldntReadByReason[reason] =
                (couldntReadByReason[reason] ?? 0) + 1;
        }
    }

    const elsewhere = latest.filter(
        (r) =>
            r.skipReason === 'no_capable_tracker' &&
            r.references.some((ref) => ref.kind === 'git_issue'),
    ).length;

    return {
        state: paused ? 'paused' : runs.length ? 'working' : 'idle',
        ...(lastRead
            ? {
                  lastTaskRead: {
                      id: lastRead.tasks[0].id,
                      tracker: lastRead.tasks[0].tracker,
                      at: lastRead.tasks[0].readAt,
                  },
              }
            : {}),
        ...(paused && pausedSince
            ? {
                  paused: {
                      tracker:
                          lastUnavailable.attempts.find(
                              (a) => a.status === 'error',
                          )?.tracker ?? 'The task tracker',
                      since: pausedSince.toISOString(),
                      uncheckedPullRequests: latest.filter(
                          (r) =>
                              r.skipReason === 'tracker_unavailable' &&
                              r.createdAt >= pausedSince,
                      ).length,
                  },
              }
            : {}),
        stats: {
            pullRequestsChecked: validated.length,
            ...(validated.length
                ? {
                      metRate:
                          validated.filter((r) => r.passed).length /
                          validated.length,
                  }
                : {}),
            ...agreement(prRuns),
            couldntRead: Object.values(couldntReadByReason).reduce(
                (a, b) => a + b,
                0,
            ),
            couldntReadByReason,
        },
        ...(elsewhere
            ? {
                  pointsElsewhere: {
                      pullRequests: elsewhere,
                      kind: 'git_issue',
                  },
              }
            : {}),
    };
}

function oldestUnavailableStreak(
    runs: ValidationRunRecord[],
    lastAnswered: Date | undefined,
): Date | undefined {
    const streak = runs.filter(
        (r) =>
            r.skipReason === 'tracker_unavailable' &&
            (!lastAnswered || r.createdAt > lastAnswered),
    );
    return streak.length ? streak[streak.length - 1].createdAt : undefined;
}

/**
 * How often developers agreed with what Kody flagged: of the requirements
 * flagged MISSING or PARTIAL and the changes flagged NOT IN TASK, the share
 * no reviewer waived and no dispute overturned.
 */
function agreement(runs: ValidationRunRecord[]): { agreedRate?: number } {
    let flagged = 0;
    let disagreed = 0;
    for (const run of latestPerPr(runs)) {
        for (const task of run.tasks ?? []) {
            for (const r of task.requirements ?? []) {
                const raised =
                    r.state === 'missing' ||
                    r.state === 'partial' ||
                    r.previousState === 'missing' ||
                    r.previousState === 'partial' ||
                    r.disputed !== undefined;
                if (!raised) {
                    continue;
                }
                flagged += 1;
                if (r.accepted || r.disputed === 'overturned') {
                    disagreed += 1;
                }
            }
            for (const c of task.outOfScope ?? []) {
                flagged += 1;
                if (c.accepted) {
                    disagreed += 1;
                }
            }
        }
    }
    return flagged ? { agreedRate: (flagged - disagreed) / flagged } : {};
}

export interface IntentCockpit {
    pullRequests: number;
    /** Of PRs checked against a task, the share whose last verdict passed. */
    metRate?: number;
    /** Of PRs checked, the share with at least one change not in the task. */
    notInTaskRate?: number;
    agreedRate?: number;
    /** Of PRs Business Logic ran on, the share with no readable task. */
    withoutTaskRate?: number;
    byAuthor: Array<{ author: string; pullRequests: number; metRate: number }>;
    /** The share of checked PRs whose author couldn't be identified. */
    unidentifiedRate?: number;
    mostMissed: Array<{ topic: RequirementTopic; pullRequests: number }>;
    byTeam: Array<{
        teamId: string;
        pullRequests: number;
        metRate?: number;
        notInTaskRate?: number;
        withoutTaskRate?: number;
    }>;
}

const WITHOUT_TASK = new Set([
    'no_reference',
    'task_not_found',
    'task_too_thin',
    'task_missing',
    'no_capable_tracker',
]);

/** The Cockpit's intent view: delivered as asked, by who wrote it and by team (UC-42). */
export function summarizeIntent(runs: ValidationRunRecord[]): IntentCockpit {
    const latest = latestPerPr(runs.filter((r) => prKey(r)));
    const firstAuthor = new Map<PrKey, ValidationRunRecord['author']>();
    for (const run of [...runs].reverse()) {
        const key = prKey(run);
        if (key && run.author && !firstAuthor.has(key)) {
            firstAuthor.set(key, run.author);
        }
    }

    const summarize = (group: ValidationRunRecord[]) => {
        const checked = group.filter((r) => r.outcome === 'validated');
        const counted = group.filter(
            (r) =>
                r.outcome !== 'skipped' || WITHOUT_TASK.has(r.skipReason ?? ''),
        );
        const withoutTask = counted.filter((r) =>
            WITHOUT_TASK.has(
                r.outcome === 'skipped' ? (r.skipReason ?? '') : r.outcome,
            ),
        );
        return {
            checked,
            metRate: checked.length
                ? checked.filter((r) => r.passed).length / checked.length
                : undefined,
            notInTaskRate: checked.length
                ? checked.filter((r) =>
                      r.tasks.some((t) => (t.outOfScope ?? []).length > 0),
                  ).length / checked.length
                : undefined,
            withoutTaskRate: counted.length
                ? withoutTask.length / counted.length
                : undefined,
        };
    };

    const all = summarize(latest);

    const authors = new Map<string, ValidationRunRecord[]>();
    let unidentified = 0;
    for (const run of all.checked) {
        const author = firstAuthor.get(prKey(run)!) ?? run.author;
        const name =
            author?.kind === 'agent'
                ? (author.agent ?? 'Agent')
                : author?.kind === 'person'
                  ? 'People'
                  : 'Not identified';
        if (name === 'Not identified') {
            unidentified += 1;
        }
        authors.set(name, [...(authors.get(name) ?? []), run]);
    }

    const missed = new Map<RequirementTopic, Set<PrKey>>();
    for (const run of all.checked) {
        for (const task of run.tasks) {
            for (const r of task.requirements ?? []) {
                const wasMissing =
                    r.state === 'missing' ||
                    r.state === 'partial' ||
                    r.previousState === 'missing' ||
                    r.previousState === 'partial';
                if (wasMissing && r.topic && r.topic !== 'other') {
                    const set = missed.get(r.topic) ?? new Set<PrKey>();
                    set.add(prKey(run)!);
                    missed.set(r.topic, set);
                }
            }
        }
    }

    const teams = new Map<string, ValidationRunRecord[]>();
    for (const run of latest) {
        if (run.teamId) {
            teams.set(run.teamId, [...(teams.get(run.teamId) ?? []), run]);
        }
    }

    return {
        pullRequests: all.checked.length,
        ...(all.metRate !== undefined ? { metRate: all.metRate } : {}),
        ...(all.notInTaskRate !== undefined
            ? { notInTaskRate: all.notInTaskRate }
            : {}),
        ...agreement(runs),
        ...(all.withoutTaskRate !== undefined
            ? { withoutTaskRate: all.withoutTaskRate }
            : {}),
        byAuthor: [...authors.entries()]
            .map(([author, group]) => ({
                author,
                pullRequests: group.length,
                metRate: group.filter((r) => r.passed).length / group.length,
            }))
            .sort((a, b) => b.pullRequests - a.pullRequests),
        ...(all.checked.length
            ? { unidentifiedRate: unidentified / all.checked.length }
            : {}),
        mostMissed: [...missed.entries()]
            .map(([topic, prs]) => ({ topic, pullRequests: prs.size }))
            .sort((a, b) => b.pullRequests - a.pullRequests)
            .slice(0, 5),
        byTeam: [...teams.entries()].map(([teamId, group]) => {
            const s = summarize(group);
            return {
                teamId,
                pullRequests: s.checked.length,
                ...(s.metRate !== undefined ? { metRate: s.metRate } : {}),
                ...(s.notInTaskRate !== undefined
                    ? { notInTaskRate: s.notInTaskRate }
                    : {}),
                ...(s.withoutTaskRate !== undefined
                    ? { withoutTaskRate: s.withoutTaskRate }
                    : {}),
            };
        }),
    };
}
