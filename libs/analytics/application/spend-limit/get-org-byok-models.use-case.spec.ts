import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { GetOrgByokModelsUseCase } from './get-org-byok-models.use-case';

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;

/** A v2 BYOK config blob carrying the given model ids (the stored shape). */
const v2 = (models: string[]) => ({
    version: 2,
    credentials: [{ id: 'c1', provider: 'openai' }],
    models: models.map((model, i) => ({
        id: `m${i}`,
        credentialId: 'c1',
        model,
    })),
    routing: {},
});

describe('GetOrgByokModelsUseCase', () => {
    let useCase: GetOrgByokModelsUseCase;
    let orgParams: { findByKey: jest.Mock };
    let parameters: { findByKey: jest.Mock };

    beforeEach(() => {
        orgParams = { findByKey: jest.fn().mockResolvedValue(null) };
        parameters = { findByKey: jest.fn().mockResolvedValue(null) };
        useCase = new GetOrgByokModelsUseCase(
            orgParams as any,
            parameters as any,
        );
    });

    it('collects every configured v2 model plus per-repo/directory overrides, deduped', async () => {
        orgParams.findByKey.mockResolvedValue({
            configValue: v2(['gpt-main', 'claude-fallback']),
        });
        parameters.findByKey.mockResolvedValue({
            configValue: {
                byokModel: 'global-model',
                repositories: [
                    {
                        configs: { byokModel: 'repo-model' },
                        directories: [
                            { configs: { byokModel: 'dir-model' } },
                            { configs: { byokModel: 'repo-model' } }, // dup
                        ],
                    },
                ],
            },
        });

        const models = await useCase.execute(ORG);

        expect(models).toEqual([
            'gpt-main',
            'claude-fallback',
            'global-model',
            'repo-model',
            'dir-model',
        ]);
        expect(orgParams.findByKey).toHaveBeenCalledWith(
            OrganizationParametersKey.BYOK_CONFIG,
            ORG,
        );
        expect(parameters.findByKey).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            ORG,
        );
    });

    it('ignores inherit-marker (empty string) byokModel overrides', async () => {
        orgParams.findByKey.mockResolvedValue({
            configValue: v2(['gpt-main']),
        });
        parameters.findByKey.mockResolvedValue({
            configValue: {
                // '' means "inherit" — not a real model to price-check.
                repositories: [
                    { configs: { byokModel: '' } },
                    { configs: { byokModel: 'real-model' } },
                ],
            },
        });

        await expect(useCase.execute(ORG)).resolves.toEqual([
            'gpt-main',
            'real-model',
        ]);
    });

    it('falls back to the configured v2 models when there is no code-review config', async () => {
        orgParams.findByKey.mockResolvedValue({
            configValue: v2(['only-main']),
        });
        parameters.findByKey.mockResolvedValue(null);

        await expect(useCase.execute(ORG)).resolves.toEqual(['only-main']);
    });

    it('is resilient when either lookup throws', async () => {
        orgParams.findByKey.mockRejectedValue(new Error('boom'));
        parameters.findByKey.mockResolvedValue({
            configValue: { repositories: [{ configs: { byokModel: 'm' } }] },
        });

        await expect(useCase.execute(ORG)).resolves.toEqual(['m']);
    });

    it('returns an empty list when nothing is configured', async () => {
        await expect(useCase.execute(ORG)).resolves.toEqual([]);
    });
});
