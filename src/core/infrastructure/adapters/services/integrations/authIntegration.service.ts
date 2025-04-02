import {
    AUTH_INTEGRATION_REPOSITORY_TOKEN,
    IAuthIntegrationRepository,
} from '@/core/domain/authIntegrations/contracts/auth-integration.repository.contracts';
import { IAuthIntegrationService } from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { AuthIntegrationEntity } from '@/core/domain/authIntegrations/entities/auth-integration.entity';
import { IAuthIntegration } from '@/core/domain/authIntegrations/interfaces/auth-integration.interface';
import { Inject, Injectable } from '@nestjs/common';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class AuthIntegrationService implements IAuthIntegrationService {
    constructor(
        @Inject(AUTH_INTEGRATION_REPOSITORY_TOKEN)
        private readonly authIntegrationRepository: IAuthIntegrationRepository,
    ) {}

    getIntegrationUuidByAuthDetails(
        authDetails: Record<string, unknown>,
        platformType: PlatformType,
    ): Promise<string> {
        return this.authIntegrationRepository.getIntegrationUuidByAuthDetails(
            authDetails,
            platformType,
        );
    }

    findOne(
        filter?: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity> {
        return this.authIntegrationRepository.findOne(filter);
    }

    find(filter?: Partial<IAuthIntegration>): Promise<AuthIntegrationEntity[]> {
        return this.authIntegrationRepository.find(filter);
    }

    findById(uuid: string): Promise<AuthIntegrationEntity> {
        return this.authIntegrationRepository.findById(uuid);
    }

    create(
        authIntegrationData: IAuthIntegration,
    ): Promise<AuthIntegrationEntity> {
        return this.authIntegrationRepository.create(authIntegrationData);
    }

    update(
        filter: Partial<IAuthIntegration>,
        data: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity> {
        return this.authIntegrationRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.authIntegrationRepository.delete(uuid);
    }

    async getPlatformAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        try {
            return await this.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
            });
        } catch (error) {
            console.log('platformkeys', error);
        }
    }
}
