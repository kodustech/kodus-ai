import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    forgejoConfigsForWebhook,
    forgejoWebhookHost,
    forgejoWebhookSource,
    githubWebhookSource,
    gitlabWebhookSource,
    instanceConfigsForWebhook,
    webhookConfigsOfInstance,
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

    it('reads the host of an SSH remote', () => {
        expect(normalizeHost('git@GitLab-B.example:acme/api.git')).toBe(
            'gitlab-b.example',
        );
        // Bracketed, as `new URL` spells an IPv6 hostname.
        expect(normalizeHost('git@[2001:DB8::1]:acme/api.git')).toBe(
            '[2001:db8::1]',
        );
        expect(normalizeHost('https://[2001:db8::1]/acme/api.git')).toBe(
            '[2001:db8::1]',
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

    it('keeps nothing when the config holds that owner/repo under another id', () => {
        const internal = {
            ...configOn('http://forgejo:3000', 'beta'),
            configValue: [
                { id: '26', name: 'beta/other' },
                { id: '27', name: 'beta/api' },
            ],
        };

        expect(forgejoConfigsForWebhook([internal], fromBeta)).toEqual([]);
    });

    it('keeps nothing for a config stored at another address whose repository was renamed', () => {
        // Neither the host nor `owner/repo` ties it to the sending
        // instance; the id alone is what other instances share.
        expect(
            forgejoConfigsForWebhook(
                [configOn('http://forgejo:3000', 'beta', 'beta/old-name')],
                fromBeta,
            ),
        ).toEqual([]);
    });
});

describe('gitlabWebhookSource', () => {
    it('reads the instance and the group/project of a merge request hook', () => {
        expect(
            gitlabWebhookSource({
                project: {
                    id: 9,
                    path_with_namespace: 'globex/billing-api',
                    git_http_url:
                        'https://GitLab-B.example/globex/billing-api.git',
                    web_url: 'https://gitlab-b.example/globex/billing-api',
                },
            }),
        ).toEqual({
            host: 'gitlab-b.example',
            repositoryFullName: 'globex/billing-api',
        });
    });

    it('reads the instance from an SSH remote when the payload has no HTTP URL', () => {
        expect(
            gitlabWebhookSource({
                project: {
                    path_with_namespace: 'globex/billing-api',
                    url: 'git@GitLab-B.example:globex/billing-api.git',
                },
            }).host,
        ).toBe('gitlab-b.example');
    });
});

describe('instanceConfigsForWebhook on GitLab', () => {
    // GitLab numbers projects per instance: project 9 is acme/web-shop on
    // gitlab-a.example and globex/billing-api on gitlab-b.example. GitLab
    // configs list each project with its http_url; an OAuth integration may
    // store no host.
    const listed = (
        org: string,
        httpUrl: string,
        name: string,
        host?: string,
    ) => ({
        team: { uuid: `team-${org}`, organization: { uuid: `org-${org}` } },
        integration: { authIntegration: { authDetails: host ? { host } : {} } },
        configValue: [{ id: '9', name, http_url: httpUrl }],
    });
    const a = listed(
        'a',
        'https://gitlab-a.example/acme/web-shop.git',
        'acme/web-shop',
    );
    const b = listed(
        'b',
        'https://gitlab-b.example/globex/billing-api.git',
        'globex/billing-api',
    );
    const fromB = {
        host: 'gitlab-b.example',
        repositoryFullName: 'globex/billing-api',
        repositoryId: 9,
    };

    it('keeps the config whose listed project is on the sending server', () => {
        expect(instanceConfigsForWebhook([a, b], fromB)).toEqual([b]);
    });

    it('never keeps the only config when it is on another server', () => {
        expect(instanceConfigsForWebhook([a], fromB)).toEqual([]);
    });

    it('keeps every organization connected to the same project on that server', () => {
        const alsoB = listed(
            'b2',
            'https://gitlab-b.example/globex/billing-api.git',
            'globex/billing-api',
        );
        expect(instanceConfigsForWebhook([a, b, alsoB], fromB)).toEqual([
            b,
            alsoB,
        ]);
    });

    it('never keeps a config listed on another server, even with the same path', () => {
        const samePathOnA = listed(
            'a',
            'https://gitlab-a.example/globex/billing-api.git',
            'globex/billing-api',
        );
        expect(instanceConfigsForWebhook([samePathOnA], fromB)).toEqual([]);
    });

    it('keeps by path a config that lists no URL, whatever the address Kodus reaches it at', () => {
        const internal = {
            ...listed('b', '', 'globex/billing-api', 'http://10.0.0.5:8080'),
            configValue: [{ id: '9', name: 'globex/billing-api' }],
        };
        expect(instanceConfigsForWebhook([a, internal], fromB)).toEqual([
            internal,
        ]);
    });

    it('keeps a config that stores no host beside a candidate on another server', () => {
        const unknown = {
            ...listed('legacy', '', 'legacy/app'),
            configValue: [{ id: '9', name: 'legacy/app' }],
        };
        expect(instanceConfigsForWebhook([unknown, a], fromB)).toEqual([
            unknown,
        ]);
    });

    it('keeps the candidates when none stores any host (legacy data)', () => {
        const unknown = {
            ...listed('legacy', '', 'legacy/app'),
            configValue: [{ id: '9', name: 'legacy/app' }],
        };
        expect(instanceConfigsForWebhook([unknown], fromB)).toEqual([unknown]);
    });
});

describe('webhookConfigsOfInstance', () => {
    const elsewhere = {
        team: { uuid: 't', organization: { uuid: 'o' } },
        configValue: [
            {
                id: '9',
                name: 'x/y',
                http_url: 'https://gitlab-a.example/x/y.git',
            },
        ],
    };
    const source = { host: 'gitlab-b.example', repositoryId: 9 };

    it('filters GitLab, Forgejo and GitHub configs by the sending instance', () => {
        expect(
            webhookConfigsOfInstance(PlatformType.GITLAB, [elsewhere], source),
        ).toEqual([]);
        expect(
            webhookConfigsOfInstance(PlatformType.FORGEJO, [elsewhere], source),
        ).toEqual([]);
        expect(
            webhookConfigsOfInstance(PlatformType.GITHUB, [elsewhere], source),
        ).toEqual([]);
    });

    it('leaves the configs of platforms with one id per repository as they are', () => {
        expect(
            webhookConfigsOfInstance(
                PlatformType.AZURE_REPOS,
                [elsewhere],
                source,
            ),
        ).toEqual([elsewhere]);
    });

    describe('on GitHub', () => {
        // GitHub Enterprise Server numbers repositories per server.
        const listedAt = (org: string, htmlUrl: string) => ({
            team: { uuid: `team-${org}`, organization: { uuid: `org-${org}` } },
            configValue: [{ id: '9', name: 'acme/api', http_url: htmlUrl }],
        });
        const onA = listedAt('a', 'https://ghe-a.example/acme/api');
        const onB = listedAt('b', 'https://ghe-b.example/acme/api');
        const dotCom = listedAt('c', 'https://github.com/acme/api');

        it('keeps the config on the Enterprise Server that sent the event', () => {
            expect(
                webhookConfigsOfInstance(PlatformType.GITHUB, [onA, onB], {
                    host: 'ghe-b.example',
                    repositoryId: 9,
                    repositoryFullName: 'acme/api',
                }),
            ).toEqual([onB]);
        });

        it('keeps the github.com configs for a github.com event', () => {
            expect(
                webhookConfigsOfInstance(PlatformType.GITHUB, [dotCom, onA], {
                    host: 'github.com',
                    repositoryId: 9,
                }),
            ).toEqual([dotCom]);
        });

        it('keeps every config when the event names no server', () => {
            expect(
                webhookConfigsOfInstance(PlatformType.GITHUB, [dotCom, onA], {
                    repositoryId: 9,
                }),
            ).toEqual([dotCom, onA]);
        });
    });
});

describe('githubWebhookSource', () => {
    it('reads the server from the web URL, not the API URL', () => {
        expect(
            githubWebhookSource({
                repository: {
                    id: 9,
                    full_name: 'acme/api',
                    url: 'https://api.github.com/repos/acme/api',
                    html_url: 'https://GitHub.com/acme/api',
                },
            }),
        ).toEqual({ host: 'github.com', repositoryFullName: 'acme/api' });
        expect(
            githubWebhookSource({
                repository: {
                    url: 'https://ghe-b.example/api/v3/repos/acme/api',
                    html_url: 'https://ghe-b.example/acme/api',
                },
            }).host,
        ).toBe('ghe-b.example');
    });
});
