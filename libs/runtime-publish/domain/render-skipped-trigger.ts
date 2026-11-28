import { createHash } from 'crypto';

import { ASKED_RUNS_REACHED_DETAIL } from '@libs/runtime/api/application/asked-runs';

// The product's answer on the PR when someone comments `@kody runtime` and no
// Run starts (screen 2). One line: why nothing ran, then what to do. The
// wording lives here only; the trigger names the reason, never the words.
// No line carries an id, a repository name, a platform message or a stack.

/** Where the environment's setup stands, for `environment_not_ready`; `unknown` when it could not be read. */
export type SkippedSetupState = 'setting_up' | 'blocked' | 'not_set_up' | 'unknown';

const AGAIN = 'comment `@kody runtime` again';

const ENVIRONMENT_NOT_READY: Record<SkippedSetupState, string> = {
    setting_up: `Kody Runtime did not run because the environment is still finishing its setup. Wait a few minutes, then ${AGAIN}.`,
    blocked: `Kody Runtime did not run because the environment's setup stopped on a blocker. Fix it on the environment's page in Kodus, then ${AGAIN}.`,
    not_set_up: `Kody Runtime did not run because the environment has not been set up yet. Start its setup in Kodus, then ${AGAIN}.`,
    unknown: `Kody Runtime did not run because the environment is not ready. Check its setup in Kodus, then ${AGAIN}.`,
};

/**
 * Every reason the trigger can skip with, and its line; null keeps the PR
 * silent. A reason missing here (one added later) is silent too.
 */
export const SKIPPED_TRIGGER_REPLIES = {
    off: `Kody Runtime did not run because it is off for this repository. Turn it on in the repository's Kody Runtime settings in Kodus, then ${AGAIN}.`,
    environment_off: `Kody Runtime did not run because it is off for the environment this repository runs in. Turn it on in the Kody Runtime settings of the environment's main repository in Kodus, then ${AGAIN}.`,
    no_environment: `Kody Runtime did not run because no Kody Runtime environment includes this repository. Create one in Kodus, then ${AGAIN}.`,
    not_triggering: `Kody Runtime did not run because this repository's environment does not run its pull requests. Turn on "Run pull requests" for this repository in the environment's settings, then ${AGAIN}.`,
    pr_not_found: `Kody Runtime did not run because Kodus could not read this pull request from the Git provider. Wait a few minutes, then ${AGAIN}.`,
    pr_not_open: `Kody Runtime did not run because this pull request is closed. Reopen it, then ${AGAIN}.`,
    fork_pull_requests_skipped: `Kody Runtime did not run because this environment does not run pull requests from forks. A maintainer can allow them in the environment's settings in Kodus.`,
    comment_runs_per_day_reached: ASKED_RUNS_REACHED_DETAIL,
    already_running: 'Kody Runtime is already running on this commit. Follow it in the Kody Runtime comment on this pull request.',
    // The Git connection itself (libs/runtime/api/domain/ports.ts RepositoryAccessProblem): only an admin fixes it.
    repository_unreachable: `Kody Runtime did not run because Kodus cannot reach this repository on the Git provider. An admin must reconnect it in the Git settings in Kodus, or reinstall the Kodus GitHub App if it was removed, then ${AGAIN}.`,
    pat_connection: `Kody Runtime did not run because this organization connects to GitHub with a personal access token, which Kody Runtime cannot use. An admin must connect GitHub with the Kodus GitHub App in the Git settings in Kodus, then ${AGAIN}.`,
    workspace_unresolved: `Kody Runtime did not run because Kodus could not pin every repository of this environment to a commit. Check the environment's repositories in Kodus, then ${AGAIN}.`,
    // Not reachable from a comment today (a comment runs on a draft and on a head that already ran); worded for when it is.
    draft: `Kody Runtime did not run because this pull request is a draft. Mark it ready for review, then ${AGAIN}.`,
    already_ran_on_head: 'Kody Runtime already ran on this commit. Its result is in the Kody Runtime comment on this pull request.',
    // Silent: the commenter may not ask, so the PR tells a stranger nothing (not even that Kody Runtime is set up here).
    commenter_not_allowed: null,
    // Silent: an event that does not parse names no PR to answer on.
    invalid_event: null,
    // Silent: `closed` events only (nothing_live, pr_still_open), or a Run cancelled with its PR; no one asked.
    nothing_live: null,
    pr_still_open: null,
    // Silent: what a PR push or open decides by the repository's rules; a comment never reads them.
    on_request_only: null,
    rule_not_matched: null,
    bot_author: null,
    new_pushes_off: null,
} as const satisfies Record<string, string | null>;

export type SkippedTriggerReason = keyof typeof SKIPPED_TRIGGER_REPLIES;

/** The line for a skipped `@kody runtime`, or null when the PR stays silent. */
/** Where in Kodus an answer's action is done, when Kodus's address is known (API_FRONTEND_URL). */
export interface SkippedTriggerLinks {
    /** The repository's Kody Runtime settings page. */
    settings?: string;
    /** The organization's environments list. */
    environments?: string;
    /** The organization's Git integration settings. */
    git?: string;
}

/** The words of each answer that name the place in Kodus, and which link they become. */
const LINKED_PHRASE: Partial<Record<string, readonly [phrase: string, link: keyof SkippedTriggerLinks]>> = {
    off: ["the repository's Kody Runtime settings in Kodus", 'settings'],
    not_triggering: ["the environment's settings", 'environments'],
    no_environment: ['Create one in Kodus', 'environments'],
    environment_off: ['Kody Runtime settings', 'environments'],
    environment_not_ready: ['in Kodus', 'environments'],
    repository_unreachable: ['the Git settings in Kodus', 'git'],
    pat_connection: ['the Git settings in Kodus', 'git'],
};

export function renderSkippedTriggerReply(reason: string, setup?: SkippedSetupState, links: SkippedTriggerLinks = {}): string | null {
    const line = reason === 'environment_not_ready' ? ENVIRONMENT_NOT_READY[setup ?? 'unknown'] : (SKIPPED_TRIGGER_REPLIES as Record<string, string | null>)[reason];
    if (!line) return null;
    const linked = LINKED_PHRASE[reason];
    const url = linked && links[linked[1]];
    // The place the action names becomes the link, so the answer stays one reason and one action.
    return guardMentions(url && line.includes(linked[0]) ? line.replace(linked[0], `[${linked[0]}](${url})`) : line);
}

/** Whether a skip reason is answered on the PR at all (before the commenter's permission is checked). */
export function isAnsweredSkip(reason: string): boolean {
    return reason === 'environment_not_ready' || !!(SKIPPED_TRIGGER_REPLIES as Record<string, string | null>)[reason];
}

/**
 * `@name` outside code would notify that account and could read as a command:
 * every mention a line carries goes in backticks.
 */
function guardMentions(line: string): string {
    return line.replace(/`[^`]*`|@[\w-]+(?:\s+runtime\b)?/g, (m) => (m.startsWith('`') ? m : `\`${m}\``));
}

/** What a skipped trigger is answered once for: the PR, its head and the reason. */
export interface SkippedTriggerReplyScope {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    /** The head the trigger read; when the Git API gave none, the head the webhook saw. */
    headSha: string;
    /** The skip reason; for `environment_not_ready`, with the setup's state (`environment_not_ready:blocked`). */
    reason: string;
}

/** The idempotency key of the answer: one row of runtime_publications per PR, head and reason. */
export function skippedTriggerReplyKey(s: SkippedTriggerReplyScope): string {
    return `trigger-skip:${s.organizationId}:${s.repositoryId}:${s.prNumber}:${s.headSha}:${s.reason}`;
}

/**
 * The hidden marker of one answer, so a post whose platform answer was lost is
 * found instead of posted again. A digest of the key: no id reaches the PR.
 * Never the Run comment's marker, which the Run comment looks for.
 */
export function skippedTriggerMarker(key: string): string {
    return `<!-- kody-runtime:skipped:${createHash('sha256').update(key).digest('hex').slice(0, 24)} -->`;
}
