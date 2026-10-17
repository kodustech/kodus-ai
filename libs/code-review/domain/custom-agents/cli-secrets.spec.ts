import {
    CLI_SECRET_MASK,
    collectStoredCustomAgents,
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

    it('drops a mask with nothing stored behind it', () => {
        const [sealed] = sealCustomAgentSecrets(
            [agent([{ env: 'OTHER_TOKEN', ciphertext: CLI_SECRET_MASK }])],
            [agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }])],
            fakeEncrypt,
        )!;

        expect(sealed.tools.cli[0].secrets).toEqual([]);
    });

    it('does not restore a secret stored for another agent', () => {
        const other = {
            ...agent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:other' }]),
            id: 'another-agent',
        };
        const [sealed] = sealCustomAgentSecrets(
            [agent([{ env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK }])],
            [other],
            fakeEncrypt,
        )!;

        expect(sealed.tools.cli[0].secrets).toEqual([]);
    });
});
