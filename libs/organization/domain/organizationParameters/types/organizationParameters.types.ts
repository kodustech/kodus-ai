export type OrganizationParametersAutoJoinConfig = {
    enabled: boolean;
    domains: string[];
};

export type OrganizationParametersAutoAssignConfig = {
    enabled: boolean;
    ignoredUsers: string[];
    allowedUsers?: string[];
    /** Release seats of users who left the git organization. Off by default. */
    autoRevokeRemovedUsers?: boolean;
    /** How long a user must stay missing from the git org before losing a seat. */
    revokeGraceDays?: number;
    /** Git id -> ISO timestamp of when the user was first seen missing. */
    pendingRevocations?: Record<string, string>;
};
