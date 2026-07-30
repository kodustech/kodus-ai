/**
 * task-context — task reference parsing (pure text → issue keys / numbers /
 * links / ARIs, plus the "is this a task reference?" predicates).
 *
 * Extracted from the task-context-read monolith. Self-contained: only depends on
 * the leaf text-utils. These turn free-form PR/task text into the candidate
 * identifiers the discovery step uses to find the right task-management tool.
 */
import { uniqueNonEmpty } from './text-utils';

const ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const ISSUE_NUMBER_REGEX = /(?:#|\bissue\s*#?\s*|\bissues\s*#?\s*)(\d+)\b/gi;
const URL_REGEX = /https?:\/\/[^\s)]+/gi;
const ARI_REGEX = /\bari:[^\s,]+/gi;

/** Trim surrounding punctuation/brackets from a URL grabbed out of prose. */
function normalizeLikelyUrl(value: string): string {
    return value
        .trim()
        .replace(/^[("'`<]+/g, '')
        .replace(/[)\]'",.;:!?]+$/g, '');
}

export function extractIssueNumbers(text: string): number[] {
    const issueNumbers = new Set<number>();

    for (const match of text.matchAll(ISSUE_NUMBER_REGEX)) {
        const rawNumber = match[1];
        const parsed = Number.parseInt(rawNumber, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
            issueNumbers.add(parsed);
        }
    }

    return [...issueNumbers];
}

export function extractIssueKeys(text: string): string[] {
    const issueKeys = new Set<string>();
    for (const match of text.matchAll(ISSUE_KEY_REGEX)) {
        if (match[1]) {
            issueKeys.add(match[1].toUpperCase());
        }
    }

    return [...issueKeys];
}

export function extractLinks(text: string): string[] {
    const links: string[] = [];
    for (const match of text.matchAll(URL_REGEX)) {
        if (match[0]) {
            const normalized = normalizeLikelyUrl(match[0]);
            if (!normalized || !isLikelyUrl(normalized)) {
                continue;
            }
            links.push(normalized);
        }
    }

    return uniqueNonEmpty(links);
}

export function extractAris(text: string): string[] {
    const resourceIds = new Set<string>();
    for (const match of text.matchAll(ARI_REGEX)) {
        if (match[0]) {
            resourceIds.add(match[0]);
        }
    }

    return [...resourceIds];
}

export function isLikelyIssueKey(value: string): boolean {
    return /^[A-Z][A-Z0-9]+-\d+$/.test(value);
}

export function isLikelyUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/** True for URLs that point at a known task tracker or a task-shaped path. */
export function isLikelyTaskReferenceUrl(value: string): boolean {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();
        const query = parsed.search.toLowerCase();

        const knownTaskHosts = [
            'atlassian.net',
            'linear.app',
            'notion.so',
            'notion.site',
            'clickup.com',
            'trello.com',
            'asana.com',
            'dev.azure.com',
            'youtrack',
            'shortcut.com',
            'monday.com',
        ];

        if (knownTaskHosts.some((keyword) => host.includes(keyword))) {
            return true;
        }

        return (
            path.includes('/browse/') ||
            path.includes('/issue/') ||
            path.includes('/issues/') ||
            path.includes('/ticket/') ||
            path.includes('/tickets/') ||
            path.includes('/task/') ||
            path.includes('/tasks/') ||
            path.includes('/work-items/') ||
            path.startsWith('/t/') ||
            query.includes('selectedissue=')
        );
    } catch {
        return false;
    }
}
