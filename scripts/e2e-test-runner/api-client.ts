/**
 * API clients for Kodus and GitHub/GitLab
 */

import axios, { AxiosInstance } from 'axios';
import { TestConfig } from './config';

export interface SignUpResponse {
    user: {
        id: string;
        email: string;
        name: string;
    };
    organization: {
        id: string;
        name: string;
    };
    team: {
        id: string;
        name: string;
    };
}

export interface LoginResponse {
    accessToken: string;
    refreshToken: string;
    user: {
        id: string;
        email: string;
    };
}

export interface Repository {
    id: string | number;
    name: string;
    fullName: string;
    private: boolean;
}

export interface TeamCliKey {
    key: string;
    teamId: string;
}

/**
 * Kodus API Client
 */
export class KodusApiClient {
    private client: AxiosInstance;
    private accessToken?: string;
    private organizationId?: string;
    private teamId?: string;

    constructor(private config: TestConfig) {
        this.client = axios.create({
            baseURL: config.apiBaseUrl,
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
    }

    private getAuthHeaders() {
        if (!this.accessToken) {
            throw new Error('Not authenticated. Call login() first.');
        }
        return { Authorization: `Bearer ${this.accessToken}` };
    }

    /**
     * Create a new account
     */
    async signUp(email: string, password: string, name: string): Promise<SignUpResponse> {
        const response = await this.client.post('/auth/signUp', {
            email,
            password,
            name,
        });
        return response.data;
    }

    /**
     * Login and store token
     */
    async login(email: string, password: string): Promise<LoginResponse> {
        const response = await this.client.post('/auth/login', {
            email,
            password,
        });

        this.accessToken = response.data.accessToken;
        return response.data;
    }

    /**
     * Set auth context (for when we know org/team from signup)
     */
    setContext(organizationId: string, teamId: string) {
        this.organizationId = organizationId;
        this.teamId = teamId;
    }

    /**
     * Get organization info
     */
    async getOrganization(): Promise<{ id: string; name: string }> {
        const response = await this.client.get('/organization/name', {
            headers: this.getAuthHeaders(),
        });
        return response.data;
    }

    /**
     * Get user's teams
     */
    async getTeams(): Promise<Array<{ id: string; name: string }>> {
        const response = await this.client.get('/team/', {
            headers: this.getAuthHeaders(),
        });
        return response.data;
    }

    /**
     * Create integration with platform (GitHub, GitLab, etc.)
     */
    async createIntegration(
        platform: 'github' | 'gitlab' | 'bitbucket' | 'azureRepos' | 'forgejo',
        token: string,
    ): Promise<any> {
        const response = await this.client.post(
            '/code-management/auth-integration',
            {
                integrationType: platform,
                authMode: 'token',
                accessToken: token,
                organizationAndTeamData: {
                    organizationId: this.organizationId,
                    teamId: this.teamId,
                },
            },
            { headers: this.getAuthHeaders() },
        );
        return response.data;
    }

    /**
     * List available repositories from connected platform
     */
    async listRepositories(page = 1, perPage = 100): Promise<Repository[]> {
        const response = await this.client.get('/code-management/repositories/org', {
            headers: this.getAuthHeaders(),
            params: {
                teamId: this.teamId,
                page,
                perPage,
            },
        });
        return response.data;
    }

    /**
     * Select repositories to monitor
     */
    async selectRepositories(repositories: Repository[]): Promise<any> {
        const response = await this.client.post(
            '/code-management/repositories',
            {
                repositories,
                teamId: this.teamId,
                type: 'replace',
            },
            { headers: this.getAuthHeaders() },
        );
        return response.data;
    }

    /**
     * Finish onboarding and optionally trigger a review
     */
    async finishOnboarding(options?: {
        reviewPR?: boolean;
        pullNumber?: number;
        repositoryName?: string;
        repositoryId?: string;
    }): Promise<any> {
        const response = await this.client.post(
            '/code-management/finish-onboarding',
            {
                teamId: this.teamId,
                ...options,
            },
            { headers: this.getAuthHeaders() },
        );
        return response.data;
    }

    /**
     * Get or create team CLI key
     */
    async getTeamCliKey(): Promise<TeamCliKey> {
        const response = await this.client.get('/team/cli-key', {
            headers: this.getAuthHeaders(),
            params: { teamId: this.teamId },
        });
        return response.data;
    }

    /**
     * Get PR suggestions (to verify review completed)
     */
    async getPRSuggestions(prUrl: string): Promise<any> {
        const response = await this.client.get('/pull-requests/suggestions', {
            headers: this.getAuthHeaders(),
            params: { prUrl },
        });
        return response.data;
    }

    /**
     * Check webhook status for a repository
     */
    async checkWebhookStatus(repositoryId: string): Promise<{ active: boolean }> {
        const response = await this.client.get('/code-management/hook-status', {
            headers: this.getAuthHeaders(),
            params: {
                organizationId: this.organizationId,
                teamId: this.teamId,
                repositoryId,
            },
        });
        return response.data;
    }
}

/**
 * GitHub API Client (for creating PRs)
 */
export class GitHubApiClient {
    private client: AxiosInstance;

    constructor(token: string) {
        this.client = axios.create({
            baseURL: 'https://api.github.com',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
    }

    /**
     * Get repository info
     */
    async getRepo(owner: string, repo: string): Promise<any> {
        const response = await this.client.get(`/repos/${owner}/${repo}`);
        return response.data;
    }

    /**
     * Get default branch
     */
    async getDefaultBranch(owner: string, repo: string): Promise<string> {
        const repoInfo = await this.getRepo(owner, repo);
        return repoInfo.default_branch;
    }

    /**
     * Get a reference (branch)
     */
    async getRef(owner: string, repo: string, ref: string): Promise<any> {
        const response = await this.client.get(`/repos/${owner}/${repo}/git/refs/heads/${ref}`);
        return response.data;
    }

    /**
     * Create a new branch
     */
    async createBranch(
        owner: string,
        repo: string,
        branchName: string,
        fromSha: string,
    ): Promise<any> {
        const response = await this.client.post(`/repos/${owner}/${repo}/git/refs`, {
            ref: `refs/heads/${branchName}`,
            sha: fromSha,
        });
        return response.data;
    }

    /**
     * Get file content
     */
    async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<any> {
        const response = await this.client.get(`/repos/${owner}/${repo}/contents/${path}`, {
            params: ref ? { ref } : undefined,
        });
        return response.data;
    }

    /**
     * Create or update a file
     */
    async createOrUpdateFile(
        owner: string,
        repo: string,
        path: string,
        content: string,
        message: string,
        branch: string,
        sha?: string,
    ): Promise<any> {
        const response = await this.client.put(`/repos/${owner}/${repo}/contents/${path}`, {
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
            sha,
        });
        return response.data;
    }

    /**
     * Create a pull request
     */
    async createPullRequest(
        owner: string,
        repo: string,
        title: string,
        body: string,
        head: string,
        base: string,
    ): Promise<any> {
        const response = await this.client.post(`/repos/${owner}/${repo}/pulls`, {
            title,
            body,
            head,
            base,
        });
        return response.data;
    }

    /**
     * Close a pull request
     */
    async closePullRequest(owner: string, repo: string, prNumber: number): Promise<any> {
        const response = await this.client.patch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
            state: 'closed',
        });
        return response.data;
    }

    /**
     * Delete a branch
     */
    async deleteBranch(owner: string, repo: string, branchName: string): Promise<void> {
        await this.client.delete(`/repos/${owner}/${repo}/git/refs/heads/${branchName}`);
    }

    /**
     * List PR comments (to check if review was posted)
     */
    async listPRComments(owner: string, repo: string, prNumber: number): Promise<any[]> {
        const response = await this.client.get(
            `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        );
        return response.data;
    }

    /**
     * List PR review comments (inline comments)
     */
    async listPRReviewComments(owner: string, repo: string, prNumber: number): Promise<any[]> {
        const response = await this.client.get(
            `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        );
        return response.data;
    }
}

/**
 * GitLab API Client (for creating MRs)
 */
export class GitLabApiClient {
    private client: AxiosInstance;

    constructor(token: string, baseUrl = 'https://gitlab.com') {
        this.client = axios.create({
            baseURL: `${baseUrl}/api/v4`,
            headers: {
                'PRIVATE-TOKEN': token,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
    }

    /**
     * Get project info
     */
    async getProject(projectPath: string): Promise<any> {
        const encodedPath = encodeURIComponent(projectPath);
        const response = await this.client.get(`/projects/${encodedPath}`);
        return response.data;
    }

    /**
     * Create a new branch
     */
    async createBranch(projectId: number, branchName: string, ref: string): Promise<any> {
        const response = await this.client.post(`/projects/${projectId}/repository/branches`, {
            branch: branchName,
            ref,
        });
        return response.data;
    }

    /**
     * Create or update a file
     */
    async createOrUpdateFile(
        projectId: number,
        path: string,
        content: string,
        message: string,
        branch: string,
    ): Promise<any> {
        const encodedPath = encodeURIComponent(path);
        const response = await this.client.post(
            `/projects/${projectId}/repository/files/${encodedPath}`,
            {
                branch,
                content,
                commit_message: message,
            },
        );
        return response.data;
    }

    /**
     * Create a merge request
     */
    async createMergeRequest(
        projectId: number,
        title: string,
        description: string,
        sourceBranch: string,
        targetBranch: string,
    ): Promise<any> {
        const response = await this.client.post(`/projects/${projectId}/merge_requests`, {
            title,
            description,
            source_branch: sourceBranch,
            target_branch: targetBranch,
        });
        return response.data;
    }

    /**
     * Close a merge request
     */
    async closeMergeRequest(projectId: number, mrIid: number): Promise<any> {
        const response = await this.client.put(`/projects/${projectId}/merge_requests/${mrIid}`, {
            state_event: 'close',
        });
        return response.data;
    }

    /**
     * Delete a branch
     */
    async deleteBranch(projectId: number, branchName: string): Promise<void> {
        const encodedBranch = encodeURIComponent(branchName);
        await this.client.delete(`/projects/${projectId}/repository/branches/${encodedBranch}`);
    }
}
