import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProfileConfigModule } from '@libs/identity/modules/profileConfig.module';
import { UserModule } from '@libs/identity/modules/user.module';
import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';

import { ManageTeamCliKeysUseCase } from '../application/use-cases/team-cli-key/manage.use-case';
import { CreateTeamUseCase } from '../application/use-cases/team/create.use-case';
import { ListTeamsWithIntegrationsUseCase } from '../application/use-cases/team/list-with-integrations.use-case';
import { ListTeamsUseCase } from '../application/use-cases/team/list.use-case';
import { TEAM_REPOSITORY_TOKEN } from '../domain/team/contracts/team.repository.contract';
import { TEAM_SERVICE_TOKEN } from '../domain/team/contracts/team.service.contract';
import { TeamModel } from '../infrastructure/adapters/repositories/schemas/team.model';
import { TeamCliKeyModel } from '../infrastructure/adapters/repositories/schemas/team-cli-key.model';
import { IntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/integration.model';
import { OrganizationParametersModule } from './organizationParameters.module';
import { ParametersModule } from './parameters.module';

import { TeamService } from '../infrastructure/adapters/services/team.service';
import { TeamDatabaseRepository } from '../infrastructure/adapters/repositories/team.repository';
import { TeamCliKeyService } from '../infrastructure/adapters/services/team-cli-key.service';
import { TeamCliKeyDatabaseRepository } from '../infrastructure/adapters/repositories/team-cli-key.repository';
import { TEAM_CLI_KEY_SERVICE_TOKEN } from '../domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_CLI_KEY_REPOSITORY_TOKEN } from '../domain/team-cli-key/contracts/team-cli-key.repository.contract';
import { CliDeviceModel } from '../infrastructure/adapters/repositories/schemas/cli-device.model';
import { CliDeviceDatabaseRepository } from '../infrastructure/adapters/repositories/cli-device.repository';
import { CliDeviceService } from '../infrastructure/adapters/services/cli-device.service';
import { CLI_DEVICE_SERVICE_TOKEN } from '../domain/cli-device/contracts/cli-device.service.contract';
import { CLI_DEVICE_REPOSITORY_TOKEN } from '../domain/cli-device/contracts/cli-device.repository.contract';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            TeamModel,
            TeamCliKeyModel,
            IntegrationModel,
            CliDeviceModel,
        ]),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => UserModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        ManageTeamCliKeysUseCase,
        CreateTeamUseCase,
        ListTeamsUseCase,
        ListTeamsWithIntegrationsUseCase,
        {
            provide: TEAM_SERVICE_TOKEN,
            useClass: TeamService,
        },
        {
            provide: TEAM_REPOSITORY_TOKEN,
            useClass: TeamDatabaseRepository,
        },
        {
            provide: TEAM_CLI_KEY_SERVICE_TOKEN,
            useClass: TeamCliKeyService,
        },
        {
            provide: TEAM_CLI_KEY_REPOSITORY_TOKEN,
            useClass: TeamCliKeyDatabaseRepository,
        },
        {
            provide: CLI_DEVICE_SERVICE_TOKEN,
            useClass: CliDeviceService,
        },
        {
            provide: CLI_DEVICE_REPOSITORY_TOKEN,
            useClass: CliDeviceDatabaseRepository,
        },
    ],
    exports: [
        TEAM_SERVICE_TOKEN,
        TEAM_REPOSITORY_TOKEN,
        TEAM_CLI_KEY_SERVICE_TOKEN,
        TEAM_CLI_KEY_REPOSITORY_TOKEN,
        CLI_DEVICE_SERVICE_TOKEN,
        CLI_DEVICE_REPOSITORY_TOKEN,
        ManageTeamCliKeysUseCase,
        CreateTeamUseCase,
        ListTeamsUseCase,
        ListTeamsWithIntegrationsUseCase,
    ],
})
export class TeamModule {}
