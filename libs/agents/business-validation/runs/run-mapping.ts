import type {
    BusinessValidationOutcome,
    BusinessValidationRequest,
    BusinessValidationResult,
} from '../business-validation.types';
import { deriveStatus } from '../judge/validation-verdict';
import type { CheckedCommit } from '../render';
import { matchPrevious, requirementKey, taskTextHash } from '../carry-over';
import type { Acceptance } from '../judge/validation.types';
import type { RunAuthor, RunTask } from './validation-run.model';
import type {
    NewValidationRun,
    ValidationRunRecord,
} from './validation-run.repository';

/** Coding agents, by what they leave in commits: author names, emails and trailers. */
const AGENTS: Array<{ name: string; pattern: RegExp }> = [
    { name: 'Claude Code', pattern: /\bclaude\b|noreply@anthropic\.com/i },
    { name: 'Codex', pattern: /\bcodex\b|openai/i },
    { name: 'Copilot agent', pattern: /copilot/i },
    { name: 'Cursor', pattern: /cursor(?:agent)?\b/i },
    { name: 'Devin', pattern: /\bdevin\b/i },
    { name: 'Gemini', pattern: /\bgemini\b|jules/i },
    { name: 'Kody', pattern: /\bkody(?:-ai)?\b/i },
];

export interface CommitInfo {
    message: string;
    authorName?: string;
    authorEmail?: string;
}

/**
 * Who wrote the PR's code: a coding agent when its commits are authored or
 * co-authored by one, a person when they are not, unknown with no commits.
 */
export function detectAuthor(
    commits: CommitInfo[] | undefined,
    login?: string,
): RunAuthor {
    if (!commits?.length) {
        return { kind: 'unknown', ...(login ? { login } : {}) };
    }
    for (const commit of commits) {
        const trailers = (
            commit.message.match(/^co-authored-by:.*$/gim) ?? []
        ).join('\n');
        const signature = [commit.authorName, commit.authorEmail, trailers]
            .filter(Boolean)
            .join('\n');
        const agent = AGENTS.find((a) => a.pattern.test(signature));
        if (agent) {
            return {
                kind: 'agent',
                agent: agent.name,
                ...(login ? { login } : {}),
            };
        }
    }
    return { kind: 'person', ...(login ? { login } : {}) };
}

export function toRunTasks(result: BusinessValidationResult): RunTask[] {
    const { outcome } = result;
    if (outcome.kind === 'validated') {
        return outcome.checks.map((check) => ({
            tracker: check.task.tracker,
            id: check.task.id,
            title: check.task.title,
            url: check.task.url,
            readAt: check.readAt,
            updatedAt: check.task.updatedAt,
            intent: check.reference?.intent,
            passed: check.passed,
            ...(check.verdict.scopeMismatch ? { scopeMismatch: true } : {}),
            requirements: check.verdict.requirements ?? [],
            outOfScope: check.verdict.outOfScope ?? [],
            textHash: check.textHash ?? taskTextHash(check.task),
        }));
    }
    return [];
}

/** What `sameResult` compares. */
type ResultFields = Pick<
    NewValidationRun,
    | 'outcome'
    | 'skipReason'
    | 'passed'
    | 'tasks'
    | 'unseenFiles'
    | 'attempts'
    | 'references'
>;

/**
 * Whether two runs reached the same result, as the author reads it (#2423):
 * the outcome, the tasks it is about and the references it looked up, the files the judge
 * could not see, and per task its verdict and scope, each requirement's state
 * and acceptance, and each out-of-scope change. A requirement is the same
 * one by the match the comment's "was missing" uses (`matchPrevious`), so a
 * re-quote in other words is not a change, and AC01 fixed while AC02 broke
 * is. The commit is left out: a new push with the same verdict is the same
 * result.
 */
export function sameResult(
    previous: ResultFields,
    next: ResultFields,
): boolean {
    if (outlineKey(previous) !== outlineKey(next)) {
        return false;
    }
    const before = new Map(
        (previous.tasks ?? []).map((t) => [`${t.tracker}:${t.id}`, t]),
    );
    return (next.tasks ?? []).every((task) => {
        const prior = before.get(`${task.tracker}:${task.id}`);
        return !!prior && sameTaskVerdict(prior, task);
    });
}

/** Everything but each task's requirements and out-of-scope changes. */
function outlineKey(run: ResultFields): string {
    return JSON.stringify([
        run.outcome,
        run.skipReason ?? null,
        run.passed ?? null,
        // A verdict is about its tasks (below): what it looked up, not every
        // mention the text has, so a description that adds "SHA-256" or
        // "#2410" changes nothing the author reads. Without a verdict the
        // comment names the references (none could be read, none found), so
        // they are the result; a stored run with no lookups still has them.
        [...new Set((run.attempts ?? []).map((a) => a.reference))].sort(),
        run.outcome === 'validated'
            ? []
            : [
                  ...new Set(
                      (run.references ?? []).map((r) => `${r.kind}:${r.id}`),
                  ),
              ].sort(),
        (run.tasks ?? [])
            .map((t) =>
                [t.tracker, t.id, t.passed, t.scopeMismatch ?? false].join('|'),
            )
            .sort(),
        [...(run.unseenFiles ?? [])].sort(),
    ]);
}

/**
 * An acceptance as the comment shows it: who gave it, why and where the work
 * went. Not its time: the same acceptance carried to a re-check keeps it, and
 * none (absent) is its own value.
 */
function acceptanceKey(accepted: Acceptance | undefined): string {
    return accepted
        ? JSON.stringify([
              accepted.by,
              accepted.reason ?? null,
              accepted.movedTo ?? null,
          ])
        : 'none';
}

function sameTaskVerdict(before: RunTask, now: RunTask): boolean {
    const was = before.requirements ?? [];
    const is = now.requirements ?? [];
    if (was.length !== is.length) {
        return false;
    }
    const matched = matchPrevious(
        is.map((r) => r.requirement),
        was.map((r) => r.requirement),
        { similar: !!before.textHash && before.textHash === now.textHash },
    );
    const sameRequirements = is.every((r, i) => {
        const at = matched[i];
        const prior = at === undefined ? undefined : was[at];
        return (
            !!prior &&
            prior.state === r.state &&
            acceptanceKey(prior.accepted) === acceptanceKey(r.accepted)
        );
    });
    const changes = (run: RunTask) =>
        (run.outOfScope ?? [])
            .map(
                (o) =>
                    `${requirementKey(o.change)}:${acceptanceKey(o.accepted)}`,
            )
            .sort()
            .join('\n');
    return sameRequirements && changes(before) === changes(now);
}

export function buildRun(
    request: BusinessValidationRequest,
    result: BusinessValidationResult,
    extra: {
        trigger?: string;
        headSha?: string;
        author?: RunAuthor;
        /** The first skip of the re-checks this run continues. */
        pendingSince?: Date;
        /** The preview this run posts, from "Test on a pull request". */
        previewId?: string;
    } = {},
): NewValidationRun {
    const { outcome } = result;
    return {
        organizationId: request.organizationAndTeamData.organizationId,
        teamId: request.organizationAndTeamData.teamId,
        repositoryId: request.repository?.id,
        repositoryName: request.repository?.name,
        pullRequestNumber: request.pullRequest?.number,
        platformType: request.platformType,
        door: request.door,
        ...(extra.trigger ? { trigger: extra.trigger } : {}),
        ...(extra.headSha ? { headSha: extra.headSha } : {}),
        ...(extra.previewId ? { previewId: extra.previewId } : {}),
        outcome: outcome.kind,
        ...(outcome.kind === 'skipped' ? { skipReason: outcome.reason } : {}),
        ...(outcome.kind === 'validated' ? { passed: outcome.passed } : {}),
        ...(outcome.kind === 'task_required' ||
        (outcome.kind === 'task_missing' && outcome.required)
            ? { passed: false }
            : {}),
        references: result.references.map((r) => ({
            kind: r.kind,
            id: r.id,
            raw: r.raw,
            source: r.source,
            intent: r.intent,
        })),
        attempts: result.attempts,
        trackers: result.trackers,
        tasks: toRunTasks(result),
        unseenFiles: outcome.kind === 'validated' ? outcome.unseenFiles : [],
        ...(extra.author ? { author: extra.author } : {}),
        // The PR is waiting on the tracker, not on its author (UC-22). A CLI
        // check never comments on the PR, so nothing re-checks it.
        ...(outcome.kind === 'skipped' &&
        outcome.reason === 'tracker_unavailable' &&
        request.pullRequest &&
        request.door !== 'cli'
            ? {
                  pendingRecheck: true,
                  pendingSince: extra.pendingSince ?? new Date(),
              }
            : {}),
    };
}

/** A validated outcome rebuilt from a recorded run, to re-render it after an acceptance. */
export function outcomeFromRun(
    tasks: RunTask[],
    unseenFiles: string[] = [],
): Extract<BusinessValidationOutcome, { kind: 'validated' }> {
    const checks = tasks.map((t) => {
        const verdict = {
            needsMoreInfo: false,
            summary: '',
            requirements: t.requirements,
            outOfScope: t.outOfScope,
            ...(t.scopeMismatch ? { scopeMismatch: true } : {}),
            ...deriveStatus({
                requirements: t.requirements,
                outOfScope: t.outOfScope,
                scopeMismatch: t.scopeMismatch,
            }),
        };
        return {
            task: {
                tracker: t.tracker,
                id: t.id,
                title: t.title,
                url: t.url,
                updatedAt: t.updatedAt,
            },
            ...(t.intent
                ? {
                      reference: {
                          kind: 'key' as const,
                          id: t.id,
                          raw: t.id,
                          source: 'title' as const,
                          intent: t.intent,
                      },
                  }
                : {}),
            verdict,
            passed: t.passed,
            readAt: t.readAt,
            ...(t.textHash ? { textHash: t.textHash } : {}),
        };
    });
    return {
        kind: 'validated',
        checks,
        thinTasks: [],
        passed: checks.every((c) => c.passed),
        unseenFiles,
    };
}

/**
 * The commits a PR was checked at before `currentSha`, oldest first, one per
 * commit (its latest check), so the comment can show how the PR got here.
 * `runs` come newest first, as the repository returns them.
 */
export function checkedCommits(
    runs: Array<
        Pick<ValidationRunRecord, 'outcome' | 'headSha' | 'passed' | 'tasks'>
    >,
    currentSha: string | undefined,
): CheckedCommit[] {
    const seen = new Set<string>(currentSha ? [currentSha] : []);
    const commits: CheckedCommit[] = [];
    for (const run of runs) {
        if (
            run.outcome !== 'validated' ||
            !run.headSha ||
            seen.has(run.headSha)
        ) {
            continue;
        }
        seen.add(run.headSha);
        const requirements = run.tasks.flatMap((t) => t.requirements ?? []);
        if (!requirements.length) {
            continue;
        }
        commits.push({
            headSha: run.headSha,
            met: requirements.filter((r) => r.state === 'met' || r.accepted)
                .length,
            total: requirements.length,
            ...(run.passed !== undefined ? { passed: run.passed } : {}),
        });
    }
    return commits.reverse();
}
