import { BadRequestException } from '@nestjs/common';
import type { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { TestByokConnectionUseCase } from './test-byok-connection.use-case';

describe('TestByokConnectionUseCase ChatGPT subscription', () => {
    const providerService = {
        isProviderSupported: jest.fn().mockReturnValue(true),
    };

    it('tests token credentials without requiring apiKey', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue(
            new Response('data: [DONE]\n\n', {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        ) as typeof fetch;
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );

        try {
            await expect(
                useCase.execute({
                    provider: 'chatgpt_subscription',
                    codexAccessToken: 'access-token',
                    codexRefreshToken: 'refresh-token',
                    accountId: 'account-id',
                    model: 'gpt-5.6-luna',
                }),
            ).resolves.toMatchObject({ ok: true, code: 'ok', httpStatus: 200 });
            expect(global.fetch).toHaveBeenCalledWith(
                'https://chatgpt.com/backend-api/codex/responses',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer access-token',
                        'chatgpt-account-id': 'account-id',
                    }),
                }),
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('classifies a 401 response as an authentication failure', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue(
            new Response('{"error":{"message":"expired token"}}', {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            }),
        ) as typeof fetch;
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );

        try {
            await expect(
                useCase.execute({
                    provider: 'chatgpt_subscription',
                    codexAccessToken: 'expired-access-token',
                    codexRefreshToken: 'refresh-token',
                    accountId: 'account-id',
                }),
            ).resolves.toMatchObject({
                ok: false,
                code: 'auth',
                httpStatus: 401,
            });
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('rejects incomplete token credentials before making a request', async () => {
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );
        await expect(
            useCase.execute({
                provider: 'chatgpt_subscription',
                codexAccessToken: 'access-token',
                accountId: 'account-id',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
