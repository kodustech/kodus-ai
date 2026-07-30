import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './configuration';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            load: [configuration],
            // Cascade: .env.local wins, then .env, then .env.test fallback.
            envFilePath: ['.env.local', '.env', '.env.test'],
        }),
    ],
})
export class AppConfigModule {}
