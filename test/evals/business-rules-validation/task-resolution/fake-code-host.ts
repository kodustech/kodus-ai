import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';

import { ResolutionFixture } from './fixture.types';

/**
 * The git host behind Kodus's own MCP tools (PR, diff, Git Issues). Only the
 * CodeManagementService methods those tools call are implemented, and they
 * answer the way the real GitHub adapter does: `getIssue` returns null for a
 * number that is a pull request, and `listIssues` drops pull requests from the
 * page it fetched (so a page holding only PRs comes back empty).
 */
export class FakeCodeHost {
    constructor(private readonly fixture: ResolutionFixture) {}

    private get repo() {
        return this.fixture.repository;
    }

    async getRepositories() {
        return [{ id: this.repo.id, name: this.repo.name }];
    }

    async getPullRequest() {
        const pr = this.fixture.pullRequest;
        const now = '2026-10-01T00:00:00Z';
        const repo = {
            id: this.repo.id,
            name: this.repo.name,
            defaultBranch: 'main',
            fullName: `${this.repo.owner}/${this.repo.name}`,
        };
        return {
            id: String(pr.number),
            number: pr.number,
            pull_number: pr.number,
            body: pr.body,
            title: pr.title,
            message: pr.body,
            state: PullRequestState.OPENED,
            organizationId: 'org-eval',
            repository: this.repo.name,
            repositoryId: this.repo.id,
            repositoryData: { id: this.repo.id, name: this.repo.name },
            prURL: `https://github.com/${repo.fullName}/pull/${pr.number}`,
            created_at: now,
            closed_at: '',
            updated_at: now,
            merged_at: '',
            participants: [],
            reviewers: [],
            sourceRefName: pr.branch,
            head: { ref: pr.branch, repo },
            targetRefName: 'main',
            base: { ref: 'main', repo },
            user: { login: 'author', name: 'Author', id: '1' },
        };
    }

    async getFilesByPullRequestId() {
        return this.fixture.pullRequest.files.map((file) => ({
            filename: file.filename,
            patch: file.patch,
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
        }));
    }

    async getIssue(params: { issueNumber: number }) {
        const item = (this.repo.issues ?? []).find(
            (i) => i.number === params.issueNumber,
        );
        if (!item || item.isPullRequest) {
            return null;
        }
        return this.mapIssue(item);
    }

    async listIssues(params: { filters?: { perPage?: number } }) {
        const perPage = Math.min(
            Math.max(1, params.filters?.perPage ?? 30),
            100,
        );
        return (this.repo.issues ?? [])
            .slice(0, perPage)
            .filter((i) => !i.isPullRequest)
            .map((i) => this.mapIssue(i));
    }

    private mapIssue(
        item: NonNullable<ResolutionFixture['repository']['issues']>[number],
    ) {
        return {
            id: String(1000 + item.number),
            number: item.number,
            title: item.title,
            body: item.body ?? null,
            state: 'open' as const,
            url: `https://github.com/${this.repo.owner}/${this.repo.name}/issues/${item.number}`,
            labels: [],
            assignees: [],
            author: { username: 'reporter' },
            createdAt: '2026-09-01T00:00:00Z',
            updatedAt: '2026-09-01T00:00:00Z',
            closedAt: null,
            platform: 'github',
        };
    }
}
