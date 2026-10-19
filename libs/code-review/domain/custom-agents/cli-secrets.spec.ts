import {
    CLI_SECRET_MASK,
    CliSecretMissingError,
    collectStoredCustomAgents,
    maskCliSecrets,
    storedCustomAgentsAtLevel,
    storedCustomAgentsForTry,
    maskCodeReviewConfigSecrets,
    maskCustomAgentSecrets,
    sealCustomAgentSecrets,
} from './cli-secrets';

const agent = (secrets: Array<Record<string, string>>) => ({
    id: 'ledger-agent',
    tools: {
        cli: [{ name: 'ledgerctl', secrets: secrets as any }],
    },
});

const fakeEncrypt = (plaintext: string) => `enc(${plaintext})`;

describe('custom agent CLI secrets', () => {
    it('masks every stored ciphertext on read', () => {
        const [masked] = maskCustomAgentSecrets([
            agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:abc' }]),
        ])!;

        expect(masked.tools.cli[0].secrets).toEqual([
            { env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK },
        ]);
    });

    it('masks agents at global, repository and directory level', () => {
        const stored = agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:abc' }]);
        const masked = maskCodeReviewConfigSecrets({
            configs: { customAgents: [stored] },
            repositories: [
                {
                    configs: { customAgents: [stored] },
                    directories: [{ configs: { customAgents: [stored] } }],
                },
            ],
        });

        expect(JSON.stringify(masked)).not.toContain('iv:abc');
        expect(collectStoredCustomAgents(masked)).toHaveLength(3);
    });

    it('encrypts a typed value and never keeps the plaintext', () => {
        const [sealed] = sealCustomAgentSecrets(
            [agent([{ env: 'LEDGER_TOKEN', value: 'plain-token' }])],
            [],
            fakeEncrypt,
        )!;

        expect(sealed.tools.cli[0].secrets).toEqual([
            { env: 'LEDGER_TOKEN', ciphertext: 'enc(plain-token)' },
        ]);
        expect(JSON.stringify(sealed)).not.toContain('"value"');
    });

    it('keeps the stored ciphertext when the mask comes back', () => {
        const [sealed] = sealCustomAgentSecrets(
            [agent([{ env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK }])],
            [agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }])],
            fakeEncrypt,
        )!;

        expect(sealed.tools.cli[0].secrets).toEqual([
            { env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' },
        ]);
    });

    it('refuses a mask with nothing stored behind it', () => {
        expect(() =>
            sealCustomAgentSecrets(
                [agent([{ env: 'OTHER_TOKEN', ciphertext: CLI_SECRET_MASK }])],
                [agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }])],
                fakeEncrypt,
            ),
        ).toThrow(CliSecretMissingError);
    });

    it('does not restore a secret stored for another agent', () => {
        const other = {
            ...agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:other' }]),
            id: 'another-agent',
        };
        expect(() =>
            sealCustomAgentSecrets(
                [agent([{ env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK }])],
                [other],
                fakeEncrypt,
            ),
        ).toThrow(CliSecretMissingError);
    });

    it('encrypts a ciphertext that is not the one stored in that slot', () => {
        const [sealed] = sealCustomAgentSecrets(
            [agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:planted' }])],
            [agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }])],
            fakeEncrypt,
        )!;

        expect(sealed.tools.cli[0].secrets).toEqual([
            { env: 'LEDGER_TOKEN', ciphertext: 'enc(iv:planted)' },
        ]);
    });

    describe('a kept secret and the CLI it goes to', () => {
        const ledgerCli = {
            name: 'ledgerctl',
            install: 'npm i -g @acme-ledger/ctl@1.2.3',
            binary: 'ledgerctl',
            allowedPrefixes: ['ledgerctl check', 'ledgerctl show'],
            allowedDomains: ['api.ledger.example', 'auth.ledger.example'],
            runsProjectCode: false,
        };
        const withCli = (
            cli: Partial<typeof ledgerCli>,
            secret: Record<string, string>,
            moreSecrets: Array<Record<string, string>> = [],
        ) => ({
            id: 'ledger-agent',
            tools: {
                cli: [
                    {
                        ...ledgerCli,
                        ...cli,
                        secrets: [secret, ...moreSecrets] as any,
                    },
                ],
            },
        });
        const stored = [
            withCli({}, { env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }),
        ];
        const mask = { env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK };

        it('keeps it for the same definition, lists in any order', () => {
            const [sealed] = sealCustomAgentSecrets(
                [
                    withCli(
                        {
                            allowedPrefixes: [
                                'ledgerctl show',
                                'ledgerctl check',
                            ],
                            allowedDomains: [
                                'auth.ledger.example',
                                'api.ledger.example',
                            ],
                        },
                        mask,
                    ),
                ],
                stored,
                fakeEncrypt,
            )!;

            expect(sealed.tools.cli[0].secrets).toEqual([
                { env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' },
            ]);
        });

        it.each([
            ['install', { install: 'npm i -g ledger-exfil@1.0.0' }],
            ['binary', { binary: 'node' }],
            [
                'allowed domains',
                {
                    allowedDomains: [
                        'api.ledger.example',
                        'collector.attacker.example',
                    ],
                },
            ],
            [
                'allowed prefixes',
                { allowedPrefixes: ['ledgerctl check', 'ledgerctl debug'] },
            ],
            ['project code flag', { runsProjectCode: true }],
        ])('drops it when the %s change', (_, change) => {
            const seal = () =>
                sealCustomAgentSecrets(
                    [withCli(change, mask)],
                    stored,
                    fakeEncrypt,
                );

            expect(seal).toThrow(CliSecretMissingError);
            expect(seal).toThrow(
                'Secret LEDGER_TOKEN of CLI "ledgerctl" must be typed again',
            );
        });

        it('drops it when a secret is added to the CLI', () => {
            const seal = () =>
                sealCustomAgentSecrets(
                    [withCli({}, mask, [{ env: 'LEDGER_ORG', value: 'acme' }])],
                    stored,
                    fakeEncrypt,
                );

            expect(seal).toThrow(
                'Secret LEDGER_TOKEN of CLI "ledgerctl" must be typed again',
            );
        });

        it('drops the others when one secret is removed from the CLI', () => {
            const twoStored = [
                withCli({}, { env: 'LEDGER_TOKEN', ciphertext: 'iv:token' }, [
                    { env: 'LEDGER_ORG', ciphertext: 'iv:org' },
                ]),
            ];

            expect(() =>
                sealCustomAgentSecrets(
                    [withCli({}, mask)],
                    twoStored,
                    fakeEncrypt,
                ),
            ).toThrow(
                'Secret LEDGER_TOKEN of CLI "ledgerctl" must be typed again',
            );
        });

        it('names the CLI and env when the CLI was renamed', () => {
            expect(() =>
                sealCustomAgentSecrets(
                    [withCli({ name: 'ledger2' } as any, mask)],
                    stored,
                    fakeEncrypt,
                ),
            ).toThrow('Secret LEDGER_TOKEN of CLI "ledger2" has no value');
        });

        it('keeps it when only the usage notes or timeout change', () => {
            const [sealed] = sealCustomAgentSecrets(
                [
                    withCli(
                        { usage: 'Run check first.', timeoutSec: 30 } as any,
                        mask,
                    ),
                ],
                stored,
                fakeEncrypt,
            )!;

            expect(sealed.tools.cli[0].secrets).toEqual([
                { env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' },
            ]);
        });

        it('encrypts a value typed again for a changed CLI', () => {
            const [sealed] = sealCustomAgentSecrets(
                [
                    withCli(
                        { binary: 'node' },
                        { env: 'LEDGER_TOKEN', value: 'new-token' },
                    ),
                ],
                stored,
                fakeEncrypt,
            )!;

            expect(sealed.tools.cli[0].secrets).toEqual([
                { env: 'LEDGER_TOKEN', ciphertext: 'enc(new-token)' },
            ]);
        });
    });

    it('lends a Try it run only the secrets of the level the caller edits', () => {
        const at = (id: string, ciphertext: string) => ({
            customAgents: [
                { ...agent([{ env: 'LEDGER_TOKEN', ciphertext }]), id },
            ],
        });
        const config = {
            configs: at('global-agent', 'iv:global'),
            repositories: [
                {
                    id: 'repo-1',
                    configs: {
                        customAgents: [
                            ...at('repo-agent', 'iv:repo').customAgents,
                            ...at('shared-agent', 'iv:repo-shared')
                                .customAgents,
                        ],
                    },
                    directories: [
                        {
                            id: 'dir-1',
                            configs: at('shared-agent', 'iv:dir-shared'),
                        },
                    ],
                },
            ],
        };
        const lent = (level: { repositoryId: string; directoryId?: string }) =>
            JSON.stringify(storedCustomAgentsForTry(config, level));

        expect(lent({ repositoryId: 'repo-1' })).not.toContain('iv:global');
        expect(lent({ repositoryId: 'repo-1' })).toContain('iv:repo');
        const atDirectory = lent({
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
        });
        expect(atDirectory).toContain('iv:dir-shared');
        expect(atDirectory).not.toContain('iv:repo-shared');
        expect(atDirectory).toContain('"iv:repo"');
        expect(atDirectory).not.toContain('iv:global');
    });

    it('reads stored agents from exactly one level', () => {
        const at = (ciphertext: string) => ({
            customAgents: [agent([{ env: 'LEDGER_TOKEN', ciphertext }])],
        });
        const config = {
            configs: at('iv:global'),
            repositories: [
                {
                    id: 'repo-1',
                    configs: at('iv:repo-1'),
                    directories: [
                        {
                            id: 'dir-1',
                            folders: [{ path: 'src/ledger' }],
                            configs: at('iv:dir-1'),
                        },
                    ],
                },
                { id: 'repo-2', configs: {} },
            ],
        };
        const secretAt = (
            level: Parameters<typeof storedCustomAgentsAtLevel>[1],
        ) => JSON.stringify(storedCustomAgentsAtLevel(config, level));

        expect(secretAt({})).toContain('iv:global');
        expect(secretAt({ repositoryId: 'global' })).toContain('iv:global');
        expect(secretAt({ repositoryId: 'repo-1' })).toContain('iv:repo-1');
        expect(secretAt({ repositoryId: 'repo-1' })).not.toContain('iv:global');
        expect(
            secretAt({ repositoryId: 'repo-1', directoryId: 'dir-1' }),
        ).toContain('iv:dir-1');
        expect(
            secretAt({
                repositoryId: 'repo-1',
                directoryPaths: ['src/ledger'],
            }),
        ).toContain('iv:dir-1');
        expect(
            storedCustomAgentsAtLevel(config, { repositoryId: 'repo-2' }),
        ).toEqual([]);
    });
});

describe('maskCliSecrets', () => {
    it('returns a masked copy and leaves the original intact', () => {
        const original = {
            configValue: {
                configs: {
                    customAgents: [
                        agent([
                            { env: 'LEDGER_TOKEN', ciphertext: 'enc(old)' },
                        ]),
                    ],
                },
            },
        };
        const masked = maskCliSecrets(original);
        expect(JSON.stringify(masked)).not.toContain('enc(old)');
        expect(JSON.stringify(original)).toContain('enc(old)');
    });

    it('drops a typed value too', () => {
        const masked = maskCliSecrets([
            agent([{ env: 'LEDGER_TOKEN', value: 'plain-token' }]),
        ]);
        expect(JSON.stringify(masked)).not.toContain('plain-token');
        expect(masked[0].tools.cli[0].secrets).toEqual([
            { env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK },
        ]);
    });

    it('returns the value itself when it holds no secret', () => {
        const value = { customAgents: [{ id: 'a', tools: { cli: [] } }] };
        expect(maskCliSecrets(value)).toBe(value);
        expect(maskCliSecrets(null)).toBeNull();
        expect(maskCliSecrets(undefined)).toBeUndefined();
    });
});
