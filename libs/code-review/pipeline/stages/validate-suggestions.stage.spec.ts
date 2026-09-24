import { Test, TestingModule } from '@nestjs/testing';

import { ValidateSuggestionsStage } from './validate-suggestions.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { SandboxSyntaxValidator } from '@libs/code-review/infrastructure/adapters/services/sandboxSyntaxValidator.service';
import { SuggestionLLMValidator } from '@libs/code-review/infrastructure/adapters/services/suggestionLLMValidator.service';
import { PlatformType } from '@libs/core/domain/enums';

/**
 * Input-contract spec for ValidateSuggestionsStage — the post-LLM stage that
 * validates committable suggestions (syntax + an LLM validator). Guards the
 * gate (feature flag, GitHub-only, needs suggestions AND changed files), that
 * the validation input cap is taken from the RESOLVED BYOK slot, the
 * write-back, and that a validation failure propagates (this stage throws).
 */
describe('ValidateSuggestionsStage — input contract', () => {
    let stage: ValidateSuggestionsStage;

    const ORG = { organizationId: 'org-1', teamId: 'team-1' };

    const buildContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: ORG,
            pullRequest: { number: 42 },
            platformType: PlatformType.GITHUB,
            validSuggestions: [{ id: 's1' }],
            changedFiles: [{ filename: 'a.ts' }],
            codeReviewConfig: {
                enableCommittableSuggestions: true,
                resolvedModelSlot: { maxInputTokens: 12345 },
            },
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateSuggestionsStage,
                { provide: SandboxSyntaxValidator, useValue: {} },
                { provide: SuggestionLLMValidator, useValue: {} },
            ],
        }).compile();

        stage = module.get(ValidateSuggestionsStage);
    });

    it.each([
        ['committable suggestions are disabled', { codeReviewConfig: { enableCommittableSuggestions: false } }],
        ['the platform is not GitHub', { platformType: PlatformType.GITLAB }],
        ['there are no suggestions', { validSuggestions: [] }],
        ['there are no changed files', { changedFiles: [] }],
    ])('skips validation (returns the context) when %s', async (_l, patch) => {
        const spy = jest.spyOn(stage as any, 'performFullValidation');
        const context = buildContext(patch as any);

        const result = await stage.execute(context);

        expect(spy).not.toHaveBeenCalled();
        expect(result).toBe(context);
    });

    it('caps the validation input using the RESOLVED BYOK slot maxInputTokens', async () => {
        jest.spyOn(stage as any, 'filterSuggestions').mockResolvedValue([{ id: 's1' }]);
        const prepare = jest
            .spyOn(stage as any, 'prepareValidationCandidates')
            .mockResolvedValue([{ id: 's1' }]);
        jest.spyOn(stage as any, 'performFullValidation').mockResolvedValue(['s1']);
        jest
            .spyOn(stage as any, 'mapValidationResults')
            .mockReturnValue([{ id: 's1', validated: true }]);

        const result = await stage.execute(buildContext());

        // the third arg is the model input cap — must come from the resolved slot
        expect(prepare).toHaveBeenCalledWith(
            [{ id: 's1' }],
            [{ filename: 'a.ts' }],
            12345,
        );
        expect((result as any).validSuggestions).toEqual([
            { id: 's1', validated: true },
        ]);
    });

    it('returns the context untouched when everything is filtered out', async () => {
        jest.spyOn(stage as any, 'filterSuggestions').mockResolvedValue([]);
        const full = jest.spyOn(stage as any, 'performFullValidation');

        const context = buildContext();
        const result = await stage.execute(context);

        expect(full).not.toHaveBeenCalled();
        expect(result).toBe(context);
    });

    it('propagates a validation failure (the stage throws, not silently skips)', async () => {
        jest
            .spyOn(stage as any, 'filterSuggestions')
            .mockRejectedValue(new Error('validator down'));

        await expect(stage.execute(buildContext())).rejects.toThrow();
    });
});
