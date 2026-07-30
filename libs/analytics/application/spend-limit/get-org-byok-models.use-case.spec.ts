import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { GetOrgByokModelsUseCase } from './get-org-byok-models.use-case';

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;

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

    it('collects BYOK main + fallback plus per-repo/directory overrides, deduped', async () => {
        orgParams.findByKey.mockResolvedValue({
            configValue: {
                main: { model: 'gpt-main' },
                fallback: { model: 'claude-fallback' },
            },
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
            configValue: { main: { model: 'gpt-main' } },
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

    it('falls back to main + fallback when there is no code-review config', async () => {
        orgParams.findByKey.mockResolvedValue({
            configValue: { main: { model: 'only-main' } },
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
