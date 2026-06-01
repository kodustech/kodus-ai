import { OrganizationAndTeamData } from '../../config/types/general/organizationAndTeamData';

export enum CheckStatus {
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
}

export enum CheckConclusion {
    SUCCESS = 'SUCCESS',
    FAILURE = 'FAILURE',
    NEUTRAL = 'NEUTRAL',
    SKIPPED = 'SKIPPED',
}

export interface CreateCheckRunParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    headSha: string;
    status: CheckStatus;
    name: string;
    output: {
        title: string;
        summary: string;
        text?: string;
    };
}

export interface UpdateCheckRunParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    checkRunId: string | number;
    status?: CheckStatus;
    name?: string;
    conclusion?: CheckConclusion;
    output?: {
        title: string;
        summary: string;
        text?: string;
    };
}

export interface IChecksAdapter {
    createCheckRun(
        params: CreateCheckRunParams,
    ): Promise<string | number | null>;
    updateCheckRun(params: UpdateCheckRunParams): Promise<boolean>;
}
