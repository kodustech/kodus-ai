import type {
    TaskLinks,
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession } from './mcp-tool-session';
import { McpTaskTracker, TrackerReadContext } from './tracker';

export const GIT_ISSUES_TOOLS = ['KODUS_GET_ISSUE'];

/**
 * Kodus's Git Issues MCP: issues of the repository's own host (GitHub,
 * GitLab, Bitbucket, Forgejo). The host answers `null` for a number that is a
 * pull request, so `Closes #70` on a PR number is not found, never a task.
 */
export class GitIssuesTracker extends McpTaskTracker {
    readonly name = 'Git Issues';

    constructor(session: McpToolSession) {
        super(session);
    }

    /**
     * `#12`, and a number a team's own id pattern captured (`TCK-(\d+)` on
     * `TCK-12`): the built-in key shapes never yield a bare number.
     */
    canRead(reference: TaskReference): boolean {
        return (
            reference.kind === 'git_issue' ||
            (reference.kind === 'key' && /^\d+$/.test(reference.id))
        );
    }

    protected async lookup(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup> {
        if (!this.canRead(reference)) {
            return { status: 'not_found' };
        }
        const repository =
            (reference.kind === 'git_issue' && reference.repository) ||
            context.repository;
        if (!repository?.owner || !repository.name) {
            return {
                status: 'error',
                message: 'The repository owner is unknown',
            };
        }

        const payload = asRecord(
            await this.session.call('KODUS_GET_ISSUE', {
                organizationId: context.organizationAndTeamData.organizationId,
                teamId: context.organizationAndTeamData.teamId,
                repository: { owner: repository.owner, name: repository.name },
                issueNumber: Number(reference.id),
            }),
        );
        if (payload.success === false) {
            return { status: 'error', message: 'Git Issues failed' };
        }
        const issue = asRecord(payload.data);
        if (
            !Object.keys(issue).length ||
            Number(issue.number) !== Number(reference.id)
        ) {
            return { status: 'not_found' };
        }

        return {
            status: 'found',
            task: {
                tracker: this.name,
                id:
                    reference.kind === 'git_issue' && reference.repository
                        ? `${repository.owner}/${repository.name}#${reference.id}`
                        : `#${reference.id}`,
                title:
                    typeof issue.title === 'string' ? issue.title : undefined,
                description:
                    typeof issue.body === 'string' ? issue.body : undefined,
                url: typeof issue.url === 'string' ? issue.url : undefined,
                links: hierarchy(issue, repository),
            },
        };
    }
}

/**
 * The parent and sub-issues the host links (GitHub). A parent in another
 * repository is named, not read: reading it needs that repository's access.
 */
function hierarchy(
    issue: Record<string, unknown>,
    repository: { owner?: string; name: string },
): TaskLinks | undefined {
    const parent = asRecord(issue.parent);
    const sameRepository =
        typeof parent.repository === 'string' &&
        parent.repository.toLowerCase() ===
            `${repository.owner}/${repository.name}`.toLowerCase();
    const subtasks = (Array.isArray(issue.subIssues) ? issue.subIssues : [])
        .map((entry) => asRecord(entry))
        .filter((sub) => typeof sub.number === 'number')
        .map((sub) => ({
            id: `#${sub.number}`,
            title: typeof sub.title === 'string' ? sub.title : undefined,
            status: typeof sub.state === 'string' ? sub.state : undefined,
        }));
    const links: TaskLinks = {
        ...(typeof parent.number === 'number'
            ? sameRepository
                ? { parentId: String(parent.number) }
                : {
                      parentId: `${parent.repository}#${parent.number}`,
                  }
            : {}),
        ...(subtasks.length ? { subtasks } : {}),
    };
    return Object.keys(links).length ? links : undefined;
}
