import { UseCases } from '@/core/application/use-cases/organization';
import { ORGANIZATION_REPOSITORY_TOKEN } from '@/core/domain/organization/contracts/organization.repository.contract';
import { ORGANIZATION_SERVICE_TOKEN } from '@/core/domain/organization/contracts/organization.service.contract';
import { OrganizationDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/organization.repository';
import { OrganizationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organization.model';
import { OrganizationService } from '@/core/infrastructure/adapters/services/organization.service';
import { OrganizationController } from '@/core/infrastructure/http/controllers/organization.controller';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './user.module';
import { TeamsModule } from './team.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { ParametersModule } from './parameters.module';
import { ProfilesModule } from './profiles.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationModel]),
        forwardRef(() => UsersModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => ProfilesModule),
    ],
    providers: [
        ...UseCases,
        PromptService,
        {
            provide: ORGANIZATION_SERVICE_TOKEN,
            useClass: OrganizationService,
        },
        {
            provide: ORGANIZATION_REPOSITORY_TOKEN,
            useClass: OrganizationDatabaseRepository,
        },
    ],
    controllers: [OrganizationController],
    exports: [
        ORGANIZATION_SERVICE_TOKEN,
        ORGANIZATION_REPOSITORY_TOKEN,
        OrganizationModule,
    ],
})
export class OrganizationModule {}
