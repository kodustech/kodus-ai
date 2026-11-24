export type OrganizationAndTeamData = {
    organizationId?: string;
    organizationName?: string;
    teamId?: string;
    teamName?: string;
    /**
     * The Git connection (`integrations.uuid`) a call is for. A workspace can
     * hold several; without it the connection is resolved from the repository.
     */
    integrationId?: string;
};
