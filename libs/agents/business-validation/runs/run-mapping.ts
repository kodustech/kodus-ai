import type {
    BusinessValidationOutcome,
    BusinessValidationRequest,
    BusinessValidationResult,
} from '../business-validation.types';
import { deriveStatus } from '../judge/validation-verdict';
import type { RunAuthor, RunTask } from './validation-run.model';
import type { NewValidationRun } from './validation-run.repository';

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
        }));
    }
    return [];
}

export function buildRun(
    request: BusinessValidationRequest,
    result: BusinessValidationResult,
    extra: {
        trigger?: string;
        headSha?: string;
        author?: RunAuthor;
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
        outcome: outcome.kind,
        ...(outcome.kind === 'skipped' ? { skipReason: outcome.reason } : {}),
        ...(outcome.kind === 'validated' ? { passed: outcome.passed } : {}),
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
        // The PR is waiting on the tracker, not on its author (UC-22).
        ...(outcome.kind === 'skipped' &&
        outcome.reason === 'tracker_unavailable' &&
        request.pullRequest
            ? { pendingRecheck: true }
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
