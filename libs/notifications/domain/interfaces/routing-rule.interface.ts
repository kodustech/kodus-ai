import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';

export interface IRoutingRule {
    uuid?: string;
    organization?: Partial<IOrganization>;
    /** Event enum value or '*' for wildcard. */
    event: string;
    /** Category group or null for all. */
    category?: string | null;
    /** Role name (e.g. 'owner', 'contributor') or '*' for all roles. */
    role: string;
    /** Channel → enabled map, e.g. { email: true, in_app: false }. */
    channels: Record<string, boolean>;
    createdAt?: Date;
    updatedAt?: Date;
}
