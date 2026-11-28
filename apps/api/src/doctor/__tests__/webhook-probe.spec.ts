jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@libs/common/utils/webhooks/webhookTokenCrypto', () => ({
    generateWebhookToken: () => 'a1b2c3:planted+token/value',
    validateWebhookToken: () => true,
}));

import { probeWebhookUrl } from '../self-hosted-doctor.service';

describe('probeWebhookUrl', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    const answering = (status: number, body: string) =>
        jest.fn(async () => new Response(body, { status })) as any;

    it('POSTs an empty payload with no event header, so the webhooks service queues nothing', async () => {
        global.fetch = answering(200, 'Webhook ignored (event not supported)');
        const answer = await probeWebhookUrl(
            'https://api.acme.dev/github/webhook',
            'GITHUB',
        );

        expect(answer).toEqual({
            status: 200,
            body: 'Webhook ignored (event not supported)',
        });
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe('https://api.acme.dev/github/webhook');
        expect(init).toMatchObject({ method: 'POST', body: '{}' });
        expect(Object.keys(init.headers)).not.toContain('x-github-event');
    });

    it('never returns the Azure token it minted, raw or URL-encoded', async () => {
        const token = 'a1b2c3:planted+token/value';
        global.fetch = answering(
            403,
            `Blocked: /azure-repos/webhook?token=${encodeURIComponent(token)} (raw ${token})`,
        );
        const answer = await probeWebhookUrl(
            'https://api.acme.dev/azure-repos/webhook',
            'AZURE_REPOS',
        );

        const [url] = (global.fetch as jest.Mock).mock.calls[0];
        expect(new URL(url).searchParams.get('token')).toBe(token);
        expect(answer.body).not.toContain(token);
        expect(answer.body).not.toContain(encodeURIComponent(token));
        expect(answer.body).toContain('<redacted>');
    });
});
