import { DeleteRepositoryCodeReviewParameterUseCase } from '../delete-repository-code-review-parameter.use-case';

const STORED_CIPHERTEXT = 'iv:ledger-ciphertext';

const agentWithSecret = () => ({
    id: 'ledger-agent',
    tools: {
        cli: [
            {
                name: 'ledgerctl',
                secrets: [
                    { env: 'LEDGER_TOKEN', ciphertext: STORED_CIPHERTEXT },
                ],
            },
        ],
    },
});

const storedConfig = () => ({
    configs: { customAgents: [agentWithSecret()] },
    repositories: [
        {
            id: 'repo-1',
            name: 'ledger',
            isSelected: true,
            configs: { customAgents: [agentWithSecret()] },
            directories: [],
        },
        {
            id: 'repo-2',
            name: 'billing',
            isSelected: true,
            configs: { customAgents: [agentWithSecret()] },
            directories: [],
        },
    ],
});

const buildUseCase = () => {
    const emit = jest.fn();
    const useCase = new DeleteRepositoryCodeReviewParameterUseCase(
        {
            findByKey: jest
                .fn()
                .mockResolvedValue({ configValue: storedConfig() }),
        } as any,
        {
            // The parameter save echoes the stored config back, as it does
            // in production.
            execute: jest.fn(async (_key, configValue) => ({
                uuid: 'param-1',
                configValue,
            })),
        } as any,
        { emit } as any,
        { execute: jest.fn() } as any,
        {
            find: jest.fn().mockResolvedValue([]),
            updateRulesStatusByFilter: jest.fn(),
        } as any,
        {
            user: {
                organization: { uuid: 'org-1' },
                uuid: 'user-1',
                email: 'dev@example.test',
            },
        } as any,
        {
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
        } as any,
    );
    return { useCase, emit };
};

describe('DeleteRepositoryCodeReviewParameterUseCase — CLI secrets', () => {
    it('never returns a stored CLI secret ciphertext', async () => {
        const { useCase, emit } = buildUseCase();

        const result = await useCase.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'dev@example.test',
            },
        } as any);

        expect(JSON.stringify(result)).toContain('LEDGER_TOKEN');
        expect(JSON.stringify(result)).not.toContain(STORED_CIPHERTEXT);
        expect(JSON.stringify(emit.mock.calls)).not.toContain(
            STORED_CIPHERTEXT,
        );
    });
});
