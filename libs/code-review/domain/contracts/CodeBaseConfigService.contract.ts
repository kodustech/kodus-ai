import {
    CodeReviewConfig,
    CodeReviewConfigWithoutLLMProvider,
    FileChange,
    KodusConfigFile,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const CODE_BASE_CONFIG_SERVICE_TOKEN = Symbol.for(
    'CodeBaseConfigService',
);

export interface ICodeBaseConfigService {
    getConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        preliminaryFiles: FileChange[],
    ): Promise<CodeReviewConfig>;

    getSimpleConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        params: {
            repositoryId?: string;
            directoryId?: string;
            preliminaryFiles?: FileChange[];
        },
    ): Promise<CodeReviewConfigWithoutLLMProvider>;

    getCodeManagementAuthenticationPlatform(
        organizationAndTeamData: OrganizationAndTeamData,
    );
    getCodeManagementPatConfigAndRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    );
    getCodeManagementConfigAndRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    );

    getDirectoryIdForPath(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        affectedPath: string,
    ): Promise<string | undefined>;

    getKodusConfigFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        overrideConfig?: boolean;
        directoryPath?: string;
        directoryId?: string;
        defaultBranch?: string;
        removeProperties?: boolean;
    }): Promise<KodusConfigFile | undefined>;

    getE2BIpAddress(): Promise<string | null>;
}
