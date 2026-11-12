import {
    forgejoConfigsOnHost,
    forgejoWebhookHost,
    normalizeHost,
} from './webhook-source-host';

const configOn = (host: string | undefined, org: string) => ({
    org,
    integration: { authIntegration: { authDetails: host ? { host } : {} } },
});

describe('normalizeHost', () => {
    it('reduces a URL or bare host to its lowercased hostname', () => {
        expect(normalizeHost('https://Git.Alpha.Example/')).toBe(
            'git.alpha.example',
        );
        expect(normalizeHost('git.alpha.example')).toBe('git.alpha.example');
        expect(normalizeHost('http://git.alpha.example:3000/x/y')).toBe(
            'git.alpha.example',
        );
    });

    it('is undefined for an empty value', () => {
        expect(normalizeHost(undefined)).toBeUndefined();
        expect(normalizeHost('  ')).toBeUndefined();
    });
});

describe('forgejoWebhookHost', () => {
    it('reads the instance host from the repository URL of the payload', () => {
        expect(
            forgejoWebhookHost({
                repository: {
                    id: 26,
                    html_url: 'https://git.beta.example/beta/api',
                },
            }),
        ).toBe('git.beta.example');
    });

    it('falls back to the clone URL', () => {
        expect(
            forgejoWebhookHost({
                repository: {
                    clone_url: 'https://git.beta.example/beta/web.git',
                },
            }),
        ).toBe('git.beta.example');
    });

    it('is undefined when the payload names no repository URL', () => {
        expect(forgejoWebhookHost({ repository: { id: 26 } })).toBeUndefined();
    });
});

describe('forgejoConfigsOnHost', () => {
    // Repository 26 is alpha/app on git.alpha.example and
    // beta/api on git.beta.example.
    const alpha = configOn('https://git.alpha.example', 'alpha');
    const beta = configOn('git.beta.example', 'beta');

    it('keeps only the configs of the instance that sent the webhook', () => {
        expect(forgejoConfigsOnHost([alpha, beta], 'git.beta.example')).toEqual(
            [beta],
        );
    });

    it('keeps nothing when only another instance has the repository id', () => {
        expect(forgejoConfigsOnHost([alpha], 'git.beta.example')).toEqual([]);
    });

    it('keeps nothing when the sending host is unknown', () => {
        expect(forgejoConfigsOnHost([alpha, beta], undefined)).toEqual([]);
    });

    it('keeps nothing for a config with no host stored', () => {
        expect(
            forgejoConfigsOnHost(
                [configOn(undefined, 'legacy')],
                'git.beta.example',
            ),
        ).toEqual([]);
    });
});
