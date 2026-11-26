import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserConnectionAccessRepository } from '../infrastructure/adapters/repositories/userConnectionAccess.repository';
import { UserConnectionAccessModel } from '../infrastructure/adapters/repositories/schemas/userConnectionAccess.model';
import { ConnectionAccessService } from '../infrastructure/adapters/services/permissions/connection-access.service';

/**
 * Who reads which Git connections. Imports nothing but its table, so every
 * module (permissions, Cockpit, notifications, team members) shares this one
 * instance: a grant change clears the cached scopes all of them read.
 */
@Module({
    imports: [TypeOrmModule.forFeature([UserConnectionAccessModel])],
    providers: [UserConnectionAccessRepository, ConnectionAccessService],
    exports: [ConnectionAccessService],
})
export class ConnectionAccessModule {}
