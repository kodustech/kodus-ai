import * as yaml from 'js-yaml';

import {
    CentralizedConfigPrService,
    CentralizedMutationPullRequestRequest,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

interface BuildKodusConfigCentralizedMutationRequestParams {
    centralizedConfigPrService: CentralizedConfigPrService;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId?: string;
    directoryPath?: string;
    configFileContent?: Partial<KodusConfigFile> | null;
    title: string;
    description: string;
    commitMessage: string;
    sourceBranchPrefix: string;
    centralizedModeMessage?: string;
    author?: { name: string; email?: string };
}

export function buildKodusConfigCentralizedMutationRequest(
    params: BuildKodusConfigCentralizedMutationRequestParams,
): CentralizedMutationPullRequestRequest {
    const normalizedDirectoryPath = normalizeDirectoryPath(params.directoryPath);

    return {
        organizationAndTeamData: params.organizationAndTeamData,
        repositoryId: params.repositoryId,
        files: ({ repositoryFolder }) => {
            const path = params.centralizedConfigPrService.buildCentralizedPath({
                repositoryFolder,
                relativePath: buildKodusConfigRelativePath(
                    normalizedDirectoryPath,
                ),
            });

            const hasContent = hasConfigContent(params.configFileContent);

            if (!hasContent) {
                return [{ path, operation: 'delete' }];
            }

            return [
                {
                    path,
                    operation: 'upsert',
                    content: yaml.dump(params.configFileContent),
                },
            ];
        },
        title: params.title,
        description: params.description,
        commitMessage: params.commitMessage,
        sourceBranch: `${params.sourceBranchPrefix}-${Date.now()}`,
        centralizedModeMessage: params.centralizedModeMessage,
        author: params.author,
    };
}

export function hasConfigContent(configFileContent?:
    | Partial<KodusConfigFile>
    | null): boolean {
    return Boolean(
        configFileContent && Object.keys(configFileContent).length > 0,
    );
}

function buildKodusConfigRelativePath(directoryPath?: string): string {
    if (!directoryPath) {
        return 'kodus-config.yml';
    }

    return `${directoryPath}/kodus-config.yml`;
}

function normalizeDirectoryPath(path?: string): string | undefined {
    if (!path) {
        return undefined;
    }

    const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized || undefined;
}
