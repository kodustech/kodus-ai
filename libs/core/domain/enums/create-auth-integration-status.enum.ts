export enum CreateAuthIntegrationStatus {
    SUCCESS = 'SUCCESS',
    NO_ORGANIZATION = 'NO_ORGANIZATION',
    NO_REPOSITORIES = 'NO_REPOSITORIES',
}

export type CreateAuthIntegrationResult = {
    success: boolean;
    status?: CreateAuthIntegrationStatus;
    /** The Git connection created or updated by the call. */
    integrationId?: string;
};
