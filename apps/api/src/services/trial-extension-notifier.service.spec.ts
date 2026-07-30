import { TrialExtensionNotifierService } from './trial-extension-notifier.service';

/**
 * The notifier owns the Discord webhook secret and must FAIL HONESTLY: when
 * the channel is unconfigured or delivery fails it returns success:false so
 * the UI never pretends the request was sent.
 */
describe('TrialExtensionNotifierService', () => {
    const ENV_KEY = 'API_DISCORD_TRIAL_REQUEST_WEBHOOK_URL';
    let savedEnv: string | undefined;
    let fetchMock: jest.Mock;

    const payload = {
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamId: 'team-1',
        requestedByEmail: 'founder@acme.dev',
        teamSize: 12,
        message: 'Evaluating for the platform team',
    };

    beforeEach(() => {
        savedEnv = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        if (savedEnv === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedEnv;
    });

    it('fails honestly (no webhook call) when the channel is not configured', async () => {
        const result = await new TrialExtensionNotifierService().notify(
            payload,
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not configured/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the request to the Discord webhook when configured', async () => {
        process.env[ENV_KEY] = 'https://discord.com/api/webhooks/abc';
        fetchMock.mockResolvedValue({ ok: true });

        const result = await new TrialExtensionNotifierService().notify(
            payload,
        );

        expect(result).toEqual({ success: true });
        const [url, config] = fetchMock.mock.calls[0];
        expect(url).toBe('https://discord.com/api/webhooks/abc');
        const content = JSON.parse(config.body).content as string;
        expect(content).toContain('Acme');
        expect(content).toContain('founder@acme.dev');
        expect(content).toContain('12');
    });

    it('fails honestly when the webhook responds non-2xx', async () => {
        process.env[ENV_KEY] = 'https://discord.com/api/webhooks/abc';
        fetchMock.mockResolvedValue({ ok: false, status: 500 });

        const result = await new TrialExtensionNotifierService().notify(
            payload,
        );

        expect(result.success).toBe(false);
    });
});
