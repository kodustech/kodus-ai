import type {
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

    canRead(reference: TaskReference): boolean {
        return reference.kind === 'git_issue';
    }

    protected async lookup(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup> {
        if (reference.kind !== 'git_issue') {
            return { status: 'not_found' };
        }
        const repository = reference.repository ?? context.repository;
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
                id: reference.repository
                    ? `${repository.owner}/${repository.name}#${reference.id}`
                    : `#${reference.id}`,
                title:
                    typeof issue.title === 'string' ? issue.title : undefined,
                description:
                    typeof issue.body === 'string' ? issue.body : undefined,
                url: typeof issue.url === 'string' ? issue.url : undefined,
            },
        };
    }
}
