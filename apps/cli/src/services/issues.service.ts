import type {
    IssueListItem,
    IssueStatus,
    IssuesFixPrompt,
} from '../types/issues.js';
import { CommandError } from '../utils/command-errors.js';
import { api } from './api/index.js';
import { userContextService } from './user-context.service.js';

const ISSUES_FEATURE = 'Issues';

/** At most this many issues go into one prompt (the API refuses more). */
export const FIX_PROMPT_MAX_ISSUES = 25;

const SEVERITY_RANK = new Map(
    ['critical', 'high', 'medium', 'low'].map((s, i) => [s, i] as const),
);

export type IssuesFilter = {
    /** Default open. */
    status?: IssueStatus | 'all';
    /** Only deep-scan findings. */
    security?: boolean;
    /** Repository name or id. */
    repo?: string;
};

const STATUSES: Array<IssueStatus | 'all'> = [
    'open',
    'resolved',
    'dismissed',
    'all',
];

class IssuesService {
    /**
     * The issues the logged-in user may read, most severe first. GET /issues
     * returns every one of them, as it does for the web, which filters on its
     * side; the filter is applied here the same way.
     */
    async list(filter: IssuesFilter = {}): Promise<IssueListItem[]> {
        const status = filter.status ?? 'open';
        if (!STATUSES.includes(status)) {
            throw new CommandError(
                'INVALID_INPUT',
                `Unknown status "${status}". Use one of: ${STATUSES.join(', ')}.`,
            );
        }
        const repo = filter.repo?.trim().toLowerCase();

        const accessToken =
            await userContextService.requireUserToken(ISSUES_FEATURE);
        const issues = (await api.issues.listIssues(accessToken)) ?? [];

        return issues
            .filter((i) => status === 'all' || i.status === status)
            .filter((i) => !filter.security || i.source === 'security_scan')
            .filter(
                (i) =>
                    !repo ||
                    i.repository?.name?.toLowerCase() === repo ||
                    String(i.repository?.id).toLowerCase() === repo,
            )
            .sort(
                (a, b) =>
                    (SEVERITY_RANK.get(a.severity) ?? -1) -
                    (SEVERITY_RANK.get(b.severity) ?? -1),
            );
    }

    /** A prompt that hands these issues to the user's own coding agent. */
    async fixPrompt(ids: string[]): Promise<IssuesFixPrompt> {
        const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
        if (wanted.length === 0) {
            throw new CommandError(
                'INVALID_INPUT',
                'Give at least one issue id.',
            );
        }
        const accessToken =
            await userContextService.requireUserToken(ISSUES_FEATURE);
        return api.issues.fixPrompt(
            accessToken,
            wanted.slice(0, FIX_PROMPT_MAX_ISSUES),
        );
    }
}

export const issuesService = new IssuesService();
