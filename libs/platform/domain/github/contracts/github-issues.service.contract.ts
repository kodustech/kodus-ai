import {
    GetGitHubIssueParams,
    GitHubIssue,
    ListGitHubIssuesParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/issues.type';

export const GITHUB_ISSUES_SERVICE_TOKEN = Symbol.for('GithubIssuesService');

export interface IGithubIssuesService {
    listIssues(params: ListGitHubIssuesParams): Promise<GitHubIssue[]>;
    getIssue(params: GetGitHubIssueParams): Promise<GitHubIssue | null>;
}
