import {
    forgejoConfigsForWebhook,
    forgejoWebhookHost,
    forgejoWebhookSource,
    normalizeHost,
} from './webhook-source-host';

const configOn = (
    host: string | undefined,
    org: string,
    repositoryFullName = `${org}/app`,
) => ({
    org,
    integration: { authIntegration: { authDetails: host ? { host } : {} } },
    configValue: [{ id: '26', name: repositoryFullName }],
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

describe('forgejoWebhookSource', () => {
    it('names the sending host and the repository', () => {
        expect(
            forgejoWebhookSource({
                repository: {
                    full_name: 'beta/api',
                    html_url: 'https://git.beta.example/beta/api',
                },
            }),
        ).toEqual({ host: 'git.beta.example', repositoryFullName: 'beta/api' });
    });
});

describe('forgejoConfigsForWebhook', () => {
    // Repository 26 is alpha/app on git.alpha.example and
    // beta/api on git.beta.example.
    const alpha = configOn('https://git.alpha.example', 'alpha', 'alpha/app');
    const beta = configOn('git.beta.example', 'beta', 'beta/api');
    const fromBeta = {
        host: 'git.beta.example',
        repositoryId: 26,
        repositoryFullName: 'beta/api',
    };

    it('keeps only the configs of the instance that sent the webhook', () => {
        expect(forgejoConfigsForWebhook([alpha, beta], fromBeta)).toEqual([
            beta,
        ]);
    });

    it('keeps the config on the sending host after the repository was renamed', () => {
        const renamed = configOn('git.beta.example', 'beta', 'beta/old-name');

        expect(forgejoConfigsForWebhook([alpha, renamed], fromBeta)).toEqual([
            renamed,
        ]);
    });

    it('keeps a config stored at another address when it keeps the same repository', () => {
        const internal = configOn('http://forgejo:3000', 'beta', 'Beta/API');

        expect(forgejoConfigsForWebhook([alpha, internal], fromBeta)).toEqual([
            internal,
        ]);
    });

    it('lets the sending host decide between configs that keep the same repository', () => {
        const elsewhere = configOn('git.gamma.example', 'gamma', 'beta/api');

        expect(forgejoConfigsForWebhook([elsewhere, beta], fromBeta)).toEqual([
            beta,
        ]);
    });

    it('keeps nothing when only another instance has the repository id', () => {
        expect(forgejoConfigsForWebhook([alpha], fromBeta)).toEqual([]);
    });

    it('keeps nothing when the payload names neither host nor repository', () => {
        expect(
            forgejoConfigsForWebhook([alpha, beta], { repositoryId: 26 }),
        ).toEqual([]);
    });

    it('keeps nothing when the same name is stored under another repository id', () => {
        expect(
            forgejoConfigsForWebhook(
                [configOn('http://forgejo:3000', 'beta', 'beta/api')],
                {
                    ...fromBeta,
                    repositoryId: 27,
                },
            ),
        ).toEqual([]);
    });
});
