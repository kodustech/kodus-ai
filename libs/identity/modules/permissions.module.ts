import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PERMISSIONS_REPOSITORY_TOKEN } from '../domain/permissions/contracts/permissions.repository.contract';
import { PERMISSIONS_SERVICE_TOKEN } from '../domain/permissions/contracts/permissions.service.contract';
import { AUTHORIZATION_SERVICE_TOKEN } from '../domain/permissions/contracts/authorization.service.contract';
import { PermissionsRepository } from '../infrastructure/adapters/repositories/permissions.repository';
import { PermissionsModel } from '../infrastructure/adapters/repositories/schemas/permissions.model';
import { AuthorizationService } from '../infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsService } from '../infrastructure/adapters/services/permissions/permissions.service';
import { PermissionsAbilityFactory } from '../infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { UseCases } from '../application/use-cases/permissions';
import { UserModule } from './user.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([PermissionsModel]),
        forwardRef(() => UserModule),
        forwardRef(() => IntegrationConfigModule),
    ],
    providers: [
        {
            provide: PERMISSIONS_REPOSITORY_TOKEN,
            useClass: PermissionsRepository,
        },
        {
            provide: PERMISSIONS_SERVICE_TOKEN,
            useClass: PermissionsService,
        },
        PermissionsAbilityFactory,
        AuthorizationService,
        {
            provide: AUTHORIZATION_SERVICE_TOKEN,
            useExisting: AuthorizationService,
        },
        ...UseCases,
    ],
    exports: [
        PERMISSIONS_REPOSITORY_TOKEN,
        PERMISSIONS_SERVICE_TOKEN,
        PermissionsAbilityFactory,
        AuthorizationService,
        AUTHORIZATION_SERVICE_TOKEN,
        ...UseCases,
    ],
})
export class PermissionsModule {}
