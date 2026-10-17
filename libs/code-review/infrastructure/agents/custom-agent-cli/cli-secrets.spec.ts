import {
    CLI_SECRET_MASK,
    CliSecretMissingError,
    maskCliSecrets,
    sealCliSecrets,
} from './cli-secrets';

const fakeEncrypt = (plain: string) => `enc(${plain})`;

const config = (ciphertext: string, agentId = 'agent-1') => ({
    customAgents: [
        {
            id: agentId,
            name: 'Ledger reviewer',
            tools: {
                cli: [
                    {
                        name: 'lintkit',
                        secrets: [{ env: 'LINTKIT_TOKEN', ciphertext }],
                    },
                ],
            },
        },
    ],
});

const secretOf = (value: any) =>
    value.customAgents[0].tools.cli[0].secrets[0].ciphertext;

describe('sealCliSecrets', () => {
    it('encrypts a new value before it is stored', () => {
        const incoming = config('lk_live_plain');
        sealCliSecrets(incoming, undefined, fakeEncrypt);
        expect(secretOf(incoming)).toBe('enc(lk_live_plain)');
    });

    it('keeps the stored ciphertext when the mask comes back', () => {
        const stored = { configs: config('enc(old)') };
        const incoming = config(CLI_SECRET_MASK);
        sealCliSecrets(incoming, stored, fakeEncrypt);
        expect(secretOf(incoming)).toBe('enc(old)');
    });

    it('finds the stored secret at repository and directory level', () => {
        const stored = {
            configs: {},
            repositories: [
                {
                    configs: {},
                    directories: [{ configs: config('enc(dir)', 'agent-9') }],
                },
            ],
        };
        const incoming = config(CLI_SECRET_MASK, 'agent-9');
        sealCliSecrets(incoming, stored, fakeEncrypt);
        expect(secretOf(incoming)).toBe('enc(dir)');
    });

    it('fails when the mask comes back for a secret that was never set', () => {
        expect(() =>
            sealCliSecrets(config(CLI_SECRET_MASK), undefined, fakeEncrypt),
        ).toThrow(CliSecretMissingError);
    });

    it('does not encrypt a stored ciphertext a second time', () => {
        const stored = { configs: config('enc(old)') };
        const incoming = config('enc(old)', 'agent-2');
        sealCliSecrets(incoming, stored, fakeEncrypt);
        expect(secretOf(incoming)).toBe('enc(old)');
    });
});

describe('maskCliSecrets', () => {
    it('returns a masked copy and leaves the original intact', () => {
        const original = { configValue: { configs: config('enc(old)') } };
        const masked = maskCliSecrets(original);
        expect(JSON.stringify(masked)).not.toContain('enc(old)');
        expect(secretOf(masked.configValue.configs)).toBe(CLI_SECRET_MASK);
        expect(secretOf(original.configValue.configs)).toBe('enc(old)');
    });

    it('masks secrets wherever the config nests them', () => {
        const value = {
            repositories: [{ directories: [{ configs: config('enc(x)') }] }],
        };
        expect(JSON.stringify(maskCliSecrets(value))).not.toContain('enc(x)');
    });

    it('returns the value itself when it holds no secret', () => {
        const value = { customAgents: [{ id: 'a', tools: { cli: [] } }] };
        expect(maskCliSecrets(value)).toBe(value);
    });

    it('passes null and undefined through', () => {
        expect(maskCliSecrets(null)).toBeNull();
        expect(maskCliSecrets(undefined)).toBeUndefined();
    });
});
