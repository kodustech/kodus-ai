import { LOG_REPOSITORY_TOKEN } from '@/core/domain/log/contracts/log.repository.contracts';
import { LOG_SERVICE_TOKEN } from '@/core/domain/log/contracts/log.service.contracts';
import { LogDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/log.repository';
import { LogModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { LogService } from '@/core/infrastructure/adapters/services/logger/log.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

@Global()
@Module({
    imports: [MongooseModule.forFeature([LogModelInstance])],
    providers: [
        PinoLoggerService,
        {
            provide: LOG_SERVICE_TOKEN,
            useClass: LogService,
        },
        {
            provide: LOG_REPOSITORY_TOKEN,
            useClass: LogDatabaseRepository,
        },
    ],
    exports: [LOG_SERVICE_TOKEN, LOG_REPOSITORY_TOKEN, PinoLoggerService],
})
export class LogModule {}
