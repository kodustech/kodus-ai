import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ResendEmailProvider } from './resend-email.provider';

describe('ResendEmailProvider', () => {
    const buildProvider = async (configValues: Record<string, string | undefined>) => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                ResendEmailProvider,
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn(
                            <T = string>(key: string): T | undefined =>
                                configValues[key] as T | undefined,
                        ),
                        getOrThrow: jest.fn(<T = string>(key: string): T => {
                            const v = configValues[key];
                            if (v === undefined) {
                                throw new Error(`Configuration key "${key}" does not exist`);
                            }
                            return v as T;
                        }),
                    },
                },
            ],
        }).compile();

        return moduleRef.get(ResendEmailProvider);
    };

    it('constructs without RESEND_API_KEY (app boots even on self-hosted without notifications configured)', async () => {
        const provider = await buildProvider({});
        expect(provider).toBeInstanceOf(ResendEmailProvider);
    });

    it('constructs with RESEND_API_KEY set', async () => {
        const provider = await buildProvider({ RESEND_API_KEY: 're_test_key' });
        expect(provider).toBeInstanceOf(ResendEmailProvider);
    });

    it('throws a clear error when send() is called without RESEND_API_KEY', async () => {
        const provider = await buildProvider({});
        await expect(
            provider.send({
                from: 'noreply@kodus.io',
                to: 'user@example.com',
                subject: 'Test',
                html: '<p>Hi</p>',
            }),
        ).rejects.toThrow(/RESEND_API_KEY is not configured/);
    });
});
