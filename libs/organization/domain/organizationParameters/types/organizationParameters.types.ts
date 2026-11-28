export type OrganizationParametersAutoJoinConfig = {
    enabled: boolean;
    domains: string[];
};

/** PR author filters of one Git connection; git ids differ per provider and host. */
export type AutoAssignConnectionFilters = {
    ignoredUsers?: string[];
    allowedUsers?: string[];
    seededBotIds?: string[];
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
    /**
     * Bot ids ever added to `ignoredUsers` automatically. Recorded so a bot an
     * admin deliberately removed is not silently ignored again on the next
     * discovery run, while genuinely new bots still get picked up.
     */
    seededBotIds?: string[];
    /**
     * Seats granted through "assign by git id". That escape hatch exists for
     * identities the member list cannot show, so their absence from it is never
     * evidence they left — they are excluded from automatic seat revocation.
     */
    manuallyAssignedIds?: string[];
    /**
     * Filters of each Git connection, by integration id. A connection with no
     * entry uses the lists above.
     */
    connections?: Record<string, AutoAssignConnectionFilters>;
};
