export const REPORT_RECIPIENTS_SERVICE_TOKEN = Symbol.for(
    'ReportRecipientsService',
);

export interface ReportRecipient {
    email: string;
    name: string;
}

export interface RepoAdminRecipient extends ReportRecipient {
    /** Warehouse `repo_full_name`s the admin administers (assigned repos). */
    repositories: string[];
}

/**
 * Contract for resolving report recipients from the identity layer. Consumers
 * depend on this interface + token rather than the concrete service, per the
 * team's DI-decoupling rule.
 */
export interface IReportRecipientsService {
    getOwners(organizationId: string): Promise<ReportRecipient[]>;
    getRepoAdmins(organizationId: string): Promise<RepoAdminRecipient[]>;
}
