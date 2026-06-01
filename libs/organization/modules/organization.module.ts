import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProfilesModule } from '@libs/identity/modules/profiles.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';

import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { GetOrganizationNameUseCase } from '../application/use-cases/organization/get-organization-name';
import { GetOrganizationsByDomainUseCase } from '../application/use-cases/organization/get-organizations-domain.use-case';
import { GetReleaseTrackUseCase } from '../application/use-cases/organization/get-release-track.use-case';
import { UpdateInfoOrganizationAndPhoneUseCase } from '../application/use-cases/organization/update-infos.use-case';
import { ORGANIZATION_REPOSITORY_TOKEN } from '../domain/organization/contracts/organization.repository.contract';
import { ORGANIZATION_SERVICE_TOKEN } from '../domain/organization/contracts/organization.service.contract';
import { OrganizationDatabaseRepository } from '../infrastructure/adapters/repositories/organization.repository';
import { OrganizationModel } from '../infrastructure/adapters/repositories/schemas/organization.model';
import { OrganizationService } from '../infrastructure/adapters/services/organization.service';
import { OrganizationParametersModule } from './organizationParameters.module';
import { ParametersModule } from './parameters.module';
import { TeamModule } from './team.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationModel]), // Added SSOConfigModel
        forwardRef(() => ProfilesModule),
        forwardRef(() => TeamModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        GetOrganizationNameUseCase,
        UpdateInfoOrganizationAndPhoneUseCase,
        GetOrganizationsByDomainUseCase,
        GetReleaseTrackUseCase,
        {
            provide: ORGANIZATION_SERVICE_TOKEN,
            useClass: OrganizationService,
        },
        {
            provide: ORGANIZATION_REPOSITORY_TOKEN,
            useClass: OrganizationDatabaseRepository,
        },
    ],
    exports: [
        ORGANIZATION_SERVICE_TOKEN,
        ORGANIZATION_REPOSITORY_TOKEN,
        GetOrganizationNameUseCase,
        UpdateInfoOrganizationAndPhoneUseCase,
        GetOrganizationsByDomainUseCase,
        GetReleaseTrackUseCase,
    ],
})
export class OrganizationModule {}
