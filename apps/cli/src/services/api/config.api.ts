import type {
    CentralizedConfigActionResponse,
    CentralizedPrMetadata,
    CentralizedConfigStatus,
    CodeReviewParameter,
    ConfigAddRepositoriesResponse,
    ConfigRepository,
    ConfigTeam,
} from '../../types/config.js';
import type { RepositorySettings } from '../../types/repo-config.js';
import type { IConfigApi } from './api.interface.js';
import { requestBinaryWithRetry, requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export class RealConfigApi implements IConfigApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    private buildAuthHeaders(accessToken: string): Record<string, string> {
        return accessToken.startsWith('kodus_')
            ? { 'X-Team-Key': accessToken }
            : { Authorization: `Bearer ${accessToken}` };
    }

    async getAvailableRepositories(
        accessToken: string,
    ): Promise<ConfigRepository[]> {
        return this.requester<ConfigRepository[]>(
            '/cli/config/repositories/available',
            {
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async getSelectedRepositories(
        accessToken: string,
    ): Promise<ConfigRepository[]> {
        return this.requester<ConfigRepository[]>(
            '/cli/config/repositories/selected',
            {
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async getTeams(accessToken: string): Promise<ConfigTeam[]> {
        return this.requester<ConfigTeam[]>('/team/', {
            headers: this.buildAuthHeaders(accessToken),
        });
    }

    async addRepositories(
        accessToken: string,
        repositoryIds: string[],
    ): Promise<ConfigAddRepositoriesResponse> {
        return this.requester<ConfigAddRepositoriesResponse>(
            '/cli/config/repositories',
            {
                method: 'POST',
                headers: this.buildAuthHeaders(accessToken),
                body: JSON.stringify({
                    repositoryIds,
                }),
            },
        );
    }

    async getCodeReviewParameter(
        accessToken: string,
        teamId: string,
    ): Promise<CodeReviewParameter> {
        return this.requester<CodeReviewParameter>(
            `/parameters/find-by-key?key=CODE_REVIEW_CONFIG&teamId=${encodeURIComponent(teamId)}`,
            {
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async createOrUpdateCodeReviewParameter(
        accessToken: string,
        params: {
            teamId: string;
            repositoryId?: string;
            configValue: Record<string, unknown>;
        },
    ): Promise<CodeReviewParameter> {
        return this.requester<CodeReviewParameter>(
            '/parameters/create-or-update-code-review',
            {
                method: 'POST',
                headers: this.buildAuthHeaders(accessToken),
                body: JSON.stringify({
                    configValue: params.configValue,
                    organizationAndTeamData: {
                        teamId: params.teamId,
                    },
                    repositoryId: params.repositoryId,
                }),
            },
        );
    }

    async updateCodeReviewParameterRepositories(
        accessToken: string,
        teamId: string,
    ): Promise<unknown> {
        return this.requester(
            '/parameters/update-code-review-parameter-repositories',
            {
                method: 'POST',
                headers: this.buildAuthHeaders(accessToken),
                body: JSON.stringify({
                    organizationAndTeamData: {
                        teamId,
                    },
                }),
            },
        );
    }

    async getRepositorySettings(
        accessToken: string,
        repositoryId: string,
    ): Promise<RepositorySettings> {
        return this.requester<RepositorySettings>(
            `/cli/config/repositories/${encodeURIComponent(repositoryId)}/settings`,
            {
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async updateRepositorySettings(
        accessToken: string,
        repositoryId: string,
        settings: RepositorySettings,
    ): Promise<
        RepositorySettings | (CentralizedPrMetadata & { mode: 'centralized-pr' })
    > {
        return this.requester<
            RepositorySettings | (CentralizedPrMetadata & { mode: 'centralized-pr' })
        >(
            `/cli/config/repositories/${encodeURIComponent(repositoryId)}/settings`,
            {
                method: 'PATCH',
                headers: this.buildAuthHeaders(accessToken),
                body: JSON.stringify(settings),
            },
        );
    }

    async getCentralizedConfigStatus(
        accessToken: string,
    ): Promise<CentralizedConfigStatus> {
        return this.requester<CentralizedConfigStatus>(
            '/cli/config/centralized/status',
            {
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async initCentralizedConfig(
        accessToken: string,
        params: {
            repositoryId: string;
            syncOption: 'pr' | 'manual';
        },
    ): Promise<CentralizedConfigActionResponse> {
        return this.requester<CentralizedConfigActionResponse>(
            '/cli/config/centralized/init',
            {
                method: 'POST',
                headers: this.buildAuthHeaders(accessToken),
                body: JSON.stringify(params),
            },
        );
    }

    async syncCentralizedConfig(
        accessToken: string,
    ): Promise<CentralizedConfigActionResponse> {
        return this.requester<CentralizedConfigActionResponse>(
            '/cli/config/centralized/sync',
            {
                method: 'POST',
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async disableCentralizedConfig(
        accessToken: string,
    ): Promise<CentralizedConfigActionResponse> {
        return this.requester<CentralizedConfigActionResponse>(
            '/cli/config/centralized/disable',
            {
                method: 'POST',
                headers: this.buildAuthHeaders(accessToken),
            },
        );
    }

    async downloadCentralizedConfig(accessToken: string): Promise<Uint8Array> {
        return requestBinaryWithRetry('/cli/config/centralized/download', {
            method: 'GET',
            headers: this.buildAuthHeaders(accessToken),
        });
    }
}
