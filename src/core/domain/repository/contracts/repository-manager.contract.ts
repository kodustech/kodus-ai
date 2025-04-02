import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { AuthMode } from '../../platformIntegrations/enums/codeManagement/authMode.enum';

export const REPOSITORY_MANAGER_TOKEN = Symbol('RepositoryManager');

export interface IRepositoryManager {
    gitCloneWithAuth(params: GitCloneParams): Promise<string>;
    deleteLocalRepository(
        organizationId: string,
        repositoryId: string,
        repositoryName: string,
        branchName: string,
    ): Promise<void>;
    listRepositoryFiles(
        organizationId: string,
        repositoryId: string,
        repositoryName: string,
        branchName: string,
        patterns?: string[],
        excludePatterns?: string[],
        maxFiles?: number,
    ): Promise<string[]>;
    readFileContent(
        organizationId: string,
        repositoryId: string,
        repositoryName: string,
        filePath: string,
        branchName: string,
    ): Promise<string>;
}

export type GitCloneParams = {
    url: string;
    provider: PlatformType;
    branch?: string;
    auth?: {
        type?: AuthMode;
        token?: string;
        org?: string;
    };
    organizationId: string;
    repositoryId: string;
    repositoryName: string;
};
