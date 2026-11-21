/** Emitted (`ORGANIZATION_DELETED_EVENT`) once an organization row was deleted: what keeps data of its own listens and deletes it. */
export const ORGANIZATION_DELETED_EVENT = 'organization.deleted';

export class OrganizationDeletedEvent {
    constructor(public readonly organizationId: string) {}
}
