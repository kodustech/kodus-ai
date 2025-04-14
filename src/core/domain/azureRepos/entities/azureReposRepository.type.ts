import { AzureReposProject } from './azureReposProject.type';

export interface AzureReposRepository {
    id: string;
    name: string;
    url: string;
    project: AzureReposProject;
    defaultBranch: string;
    size: number;
    remoteUrl: string;
    sshUrl: string;
    webUrl: string;
    isDisabled: boolean;
    isInMaintenance: boolean;
}
