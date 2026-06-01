import type { ReleaseTrack } from '@libs/feature-gate/domain/release-track';

import { IOrganizationRepository } from './organization.repository.contract';
import { OrganizationEntity } from '../entities/organization.entity';
import { IOrganization } from '../interfaces/organization.interface';

export const ORGANIZATION_SERVICE_TOKEN = Symbol.for('OrganizationService');

export interface IOrganizationService extends IOrganizationRepository {
    createOrganizationWithTenant(
        organizationData: Partial<IOrganization>,
    ): Promise<OrganizationEntity | undefined>;
    findOneByUserId(user_id: string): Promise<OrganizationEntity | undefined>;
    /**
     * Returns the org's release track, falling back to the safe default
     * (`beta`) when the org isn't found. Cached upstream by callers if hot.
     */
    getReleaseTrack(organizationId: string): Promise<ReleaseTrack>;
}
