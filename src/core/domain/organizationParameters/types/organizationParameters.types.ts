export type OrganizationParametersAutoJoinConfig = {
    enabled: boolean;
    domains: string[];
};

export type OrganizationParametersAutoAssignConfig = {
    enabled: boolean;
    ignoredUsers: string[];
    allowedUsers?: string[];
};
