import { UseCases } from '@/core/application/use-cases/organizationAutomation';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationStrategyModule } from './automationStrategy.module';
import { SlackModule } from './slack.module';
import { OrganizationModule } from './organization.module';
import { AutomationModule } from './automation.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { ProfileConfigModule } from './profileConfig.module';
import { OrganizationAutomationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organizationAutomation.model';
import { OrganizationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organization.model';
import { OrganizationAutomationRepository } from '@/core/infrastructure/adapters/repositories/typeorm/organizationAutomation.repository';
import { ORGANIZATION_AUTOMATION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/organization-automation.repository';
import { ORGANIZATION_AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/organization-automation.service';
import { OrganizationAutomationService } from '@/core/infrastructure/adapters/services/automation/organization-automation.service';
import { OrganizationAutomationController } from '@/core/infrastructure/http/controllers/organizationAutomation.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationAutomationModel]),
        forwardRef(() => OrganizationModel),
        forwardRef(() => AutomationStrategyModule),
        forwardRef(() => SlackModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => OrganizationModule),
        ProfileConfigModule,
    ],
    providers: [
        ...UseCases,
        {
            provide: ORGANIZATION_AUTOMATION_REPOSITORY_TOKEN,
            useClass: OrganizationAutomationRepository,
        },
        {
            provide: ORGANIZATION_AUTOMATION_SERVICE_TOKEN,
            useClass: OrganizationAutomationService,
        },
    ],
    controllers: [OrganizationAutomationController],
    exports: [
        ORGANIZATION_AUTOMATION_REPOSITORY_TOKEN,
        ORGANIZATION_AUTOMATION_SERVICE_TOKEN,
    ],
})
export class OrganizationAutomationModule { }
