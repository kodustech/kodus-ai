export enum Criticality {
    /**
     * Operational system flows (email confirmation, password reset,
     * invites, SSO domain verification). Delivered on whichever channels
     * the catalog declares as defaults — admins cannot override the
     * routing through the settings UI.
     */
    SYSTEM = 'system',
    CRITICAL = 'critical',
    TRANSACTIONAL = 'transactional',
    INFORMATIONAL = 'informational',
}
