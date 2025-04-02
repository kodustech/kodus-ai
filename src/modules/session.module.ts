import { SESSION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/session.repository.contracts';
import { SESSION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/session.service.contracts';
import { SessionModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { SessionDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/session.repository';
import { SessionService } from '@/core/infrastructure/adapters/services/session.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
    imports: [MongooseModule.forFeature([SessionModelInstance])],
    providers: [
        {
            provide: SESSION_SERVICE_TOKEN,
            useClass: SessionService,
        },
        {
            provide: SESSION_REPOSITORY_TOKEN,
            useClass: SessionDatabaseRepository,
        },
    ],
    exports: [SESSION_SERVICE_TOKEN, SESSION_REPOSITORY_TOKEN],
})
export class SessionModule {}
