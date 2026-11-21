import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { ORGANIZATION_DELETED_EVENT, OrganizationDeletedEvent } from '@libs/core/domain/events/organization-deleted.event';
import { createLogger } from '@libs/core/log/logger';
import {
    DEFAULT_RELEASE_TRACK,
    type ReleaseTrack,
} from '@libs/feature-gate/domain/release-track';
import {
    IOrganizationRepository,
    ORGANIZATION_REPOSITORY_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.repository.contract';
import { IOrganizationService } from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { OrganizationEntity } from '@libs/organization/domain/organization/entities/organization.entity';
import {
    CreateOrganization,
    IOrganization,
} from '@libs/organization/domain/organization/interfaces/organization.interface';

@Injectable()
export class OrganizationService implements IOrganizationService {
    private readonly logger = createLogger(OrganizationService.name);

    constructor(
        @Inject(ORGANIZATION_REPOSITORY_TOKEN)
        private readonly organizationRepository: IOrganizationRepository,
        // Absent in a process without the event module: nothing listens there, and the delete is the same.
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    public update(
        filter: Partial<IOrganization>,
        data: Partial<IOrganization>,
    ): Promise<OrganizationEntity | undefined> {
        return this.organizationRepository.update(filter, data);
    }

    public find(filter: Partial<IOrganization>): Promise<OrganizationEntity[]> {
        return this.organizationRepository.find(filter);
    }

    public findOne(
        filter: Partial<IOrganization>,
    ): Promise<OrganizationEntity> {
        return this.organizationRepository.findOne(filter);
    }

    public findById(uuid: string): Promise<OrganizationEntity> {
        return this.organizationRepository.findById(uuid);
    }

    async findOneByUserId(user_id: string): Promise<OrganizationEntity> {
        return this.organizationRepository.findById(user_id);
    }

    async createOrganizationWithTenant(
        organizationData: Partial<CreateOrganization>,
    ): Promise<OrganizationEntity> {
        const payload = {
            ...organizationData,
        } as Omit<CreateOrganization, 'uuid'>;

        const savedOrganization = await this.create(payload);

        return savedOrganization;
    }

    public async create(
        payload: Omit<CreateOrganization, 'uuid'>,
    ): Promise<OrganizationEntity> {
        const uuid = uuidv4();

        const tenantName = `${payload.name}-${uuid}`;

        return await this.organizationRepository.create({
            ...payload,
            tenantName,
            uuid,
        });
    }

    public async deleteOne(filter: Partial<IOrganization>): Promise<void> {
        // The id is known before the row goes: a filter by anything else is resolved first, so the event names the org.
        const organizationId = filter.uuid ?? (await this.organizationRepository.findOne(filter))?.uuid;
        await this.organizationRepository.deleteOne(filter);
        // Listeners delete the data the organization left elsewhere (the Kody Runtime's). Best effort: a listener's
        // failure is its own to log and retry, and the organization stays deleted.
        if (organizationId) {
            try {
                this.events?.emit(ORGANIZATION_DELETED_EVENT, new OrganizationDeletedEvent(organizationId));
            } catch (error) {
                this.logger.warn({ message: 'Organization deleted event failed', context: OrganizationService.name, error: error instanceof Error ? error : undefined, metadata: { organizationId } });
            }
        }
    }

    public async getReleaseTrack(
        organizationId: string,
    ): Promise<ReleaseTrack> {
        try {
            // The repository's `findById` is misnamed — it actually
            // queries by `user.uuid`, not by `organization.uuid` (see
            // `findOneByUserId` below, which delegates to it). For
            // release-track we have the organization uuid in hand, so
            // use `findOne({ uuid })` which filters on the entity's own
            // primary key.
            const org = await this.organizationRepository.findOne({
                uuid: organizationId,
            });
            return org?.releaseTrack ?? DEFAULT_RELEASE_TRACK;
        } catch {
            return DEFAULT_RELEASE_TRACK;
        }
    }
}
