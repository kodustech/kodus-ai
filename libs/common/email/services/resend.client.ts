import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class ResendClientProvider {
    private client: Resend | null = null;

    constructor(private readonly configService: ConfigService) {}

    getClient(): Resend {
        if (!this.client) {
            const apiKey = this.configService.get<string>('RESEND_API_KEY');
            if (!apiKey) {
                throw new Error('RESEND_API_KEY is not set');
            }
            this.client = new Resend(apiKey);
        }
        return this.client;
    }
}
