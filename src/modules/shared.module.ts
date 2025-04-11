import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { TransformInterceptor } from '@/shared/infrastructure/interceptors/transform.interceptor';
import { configOptions } from '../config';
import { LoggingInterceptor } from '@/shared/infrastructure/interceptors/logging.interceptor';
import { LogModule } from './log.module';
import { ExceptionsFilter } from '@/shared/infrastructure/filters/exceptions.filter';

@Module({
    imports: [ConfigModule.forRoot(configOptions), LogModule],
    providers: [
        {
            provide: APP_FILTER,
            useClass: ExceptionsFilter,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: TransformInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: LoggingInterceptor,
        },
    ],
})
export class SharedModule {}
