/**
 * task-context — "is this the task the PR asked for?".
 *
 * A discovery tool can answer with something other than what was requested: a
 * list tool returns every open issue and the richest one wins the score, a
 * search returns a neighbour, a get falls back to a default. Nothing downstream
 * can tell the difference — a wrong-but-detailed task reads as a successful
 * fetch and produces confident findings against requirements the PR never
 * claimed to implement.
 *
 * The check only rejects on positive evidence of a *different* task. PR prose
 * routinely mentions keys from other trackers than the connected one, so an
 * identifier we cannot compare is not grounds to throw a fetch away.
 * Pure — no IO, no LLM.
 */
import type { TaskContextNormalized } from '../types';
import type { TaskContextHints } from './task-context.types';
import { extractIssueKeys, isLikelyIssueKey } from './task-references';

/** Issue number as it appears in a tracker URL: `/issues/993`, `/browse/42`. */
const URL_ISSUE_NUMBER =
    /\/(?:issues?|tickets?|tasks?|browse)\/(\d+)(?:[/?#]|$)/i;

interface TaskIdentity {
    keys: string[];
    numbers: number[];
    links: string[];
}

/**
 * True when the fetched task is the one the PR referenced, or when the two
 * carry no comparable identifier — in which case the caller's own usability
 * heuristics decide.
 */
export function matchesRequestedTask(
    value: TaskContextNormalized,
    hints: Pick<
        TaskContextHints,
        'issueKeys' | 'issueNumbers' | 'issueLinks' | 'explicitIssueKeys'
    >,
): boolean {
    const requested = requestedIdentity(hints);

    if (
        !requested.keys.length &&
        !requested.numbers.length &&
        !requested.links.length
    ) {
        return true;
    }

    const candidate = candidateIdentity(value);

    if (
        requested.keys.some((key) => candidate.keys.includes(key)) ||
        requested.numbers.some((number) => candidate.numbers.includes(number)) ||
        requested.links.some((link) => candidate.links.includes(link))
    ) {
        return true;
    }

    // Nothing matched. Only call that a mismatch on a dimension where both
    // sides actually have something to compare.
    const comparable =
        (requested.keys.length > 0 && candidate.keys.length > 0) ||
        (requested.numbers.length > 0 && candidate.numbers.length > 0) ||
        (requested.links.length > 0 && candidate.links.length > 0);

    return !comparable;
}

/**
 * `#993` reaches the hints as a "key" but is a number, not an identifier any
 * tracker echoes back; the number list carries the same reference in a
 * comparable form.
 */
function requestedIdentity(
    hints: Pick<
        TaskContextHints,
        'issueKeys' | 'issueNumbers' | 'issueLinks' | 'explicitIssueKeys'
    >,
): TaskIdentity {
    const keys = [
        ...(hints.explicitIssueKeys ?? []),
        ...(hints.issueKeys ?? []),
    ].map((key) => key.trim().toUpperCase());

    return {
        keys: unique(keys.filter(isLikelyIssueKey)),
        numbers: unique(hints.issueNumbers ?? []),
        links: unique((hints.issueLinks ?? []).map(normalizeUrl)).filter(
            Boolean,
        ),
    };
}

function candidateIdentity(value: TaskContextNormalized): TaskIdentity {
    const id = value.id?.trim() ?? '';
    const links = (value.links ?? []).map((link) => link.trim());

    const keys = [
        ...(isLikelyIssueKey(id.toUpperCase()) ? [id.toUpperCase()] : []),
        // Providers that key issues internally still quote the human key in the
        // title ("PROJ-42: add retries").
        ...extractIssueKeys((value.title ?? '').toUpperCase()),
    ];

    const numbers = [
        ...(/^\d+$/.test(id) ? [Number.parseInt(id, 10)] : []),
        ...links
            .map(issueNumberFromUrl)
            .filter((number): number is number => number !== undefined),
    ];

    return {
        keys: unique(keys),
        numbers: unique(numbers),
        links: unique(links.map(normalizeUrl)).filter(Boolean),
    };
}

function issueNumberFromUrl(url: string): number | undefined {
    const match = url.match(URL_ISSUE_NUMBER);
    if (!match) {
        return undefined;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeUrl(value: string): string {
    return value.trim().toLowerCase().replace(/\/+$/, '');
}

function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}
