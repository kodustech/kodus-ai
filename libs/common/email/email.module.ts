import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EmailService } from './services/email.service';
import { ResendClientProvider } from './services/resend.client';

@Module({
    imports: [ConfigModule],
    providers: [ResendClientProvider, EmailService],
    exports: [EmailService, ResendClientProvider],
})
export class EmailModule {}
