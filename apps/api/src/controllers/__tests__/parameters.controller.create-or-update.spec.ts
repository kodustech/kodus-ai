import { BadRequestException } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums';
import { ParametersController } from '../parameters.controller';

const buildController = (
    useCases: {
        createOrUpdateParametersUseCase?: { execute: jest.Mock };
        updateOrCreateCodeReviewParameterUseCase?: { execute: jest.Mock };
    },
    request: any,
) =>
    new ParametersController(
        request,
        useCases.createOrUpdateParametersUseCase as any,
        null as any, // findByKeyParametersUseCase
        useCases.updateOrCreateCodeReviewParameterUseCase as any,
        null as any, // updateCodeReviewParameterRepositoriesUseCase
        null as any, // generateKodusConfigFileUseCase
        null as any, // deleteRepositoryCodeReviewParameterUseCase
        null as any, // previewPrSummaryUseCase
        null as any, // listCodeReviewAutomationLabelsWithStatusUseCase
        null as any, // getDefaultConfigUseCase
        null as any, // getCodeReviewParameterUseCase
        null as any, // getCodeReviewScopesUseCase
        null as any, // centralizedConfigSyncUseCase
        null as any, // centralizedConfigDownloadZipUseCase
        null as any, // centralizedConfigInitUseCase
        null as any, // codeBaseConfigService
    );

describe('ParametersController › createOrUpdate with code_review_config', () => {
    const request = {
        user: { uuid: 'user-1', organization: { uuid: 'org-1' } },
    };

    const setup = () => {
        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };
        const controller = buildController(
            { updateOrCreateCodeReviewParameterUseCase },
            request,
        );
        const save = (configValue: unknown) =>
            controller.createOrUpdate({
                key: ParametersKey.CODE_REVIEW_CONFIG,
                configValue,
                organizationAndTeamData: { teamId: 'team-1' },
            });

        return {
            save,
            execute: updateOrCreateCodeReviewParameterUseCase.execute,
        };
    };

    it.each([
        ['"false"', { conversation: { implicitReplies: 'false' } }],
        ['"off"', { conversation: { implicitReplies: 'off' } }],
        ['[false]', { conversation: { implicitReplies: [false] } }],
        ['a string block', { conversation: 'off' }],
        ['an unknown key', { notASetting: true }],
    ])('rejects %s and saves nothing', async (_, configValue) => {
        const { save, execute } = setup();

        await expect(save(configValue)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('saves a boolean implicitReplies as a boolean', async () => {
        const { save, execute } = setup();

        await save({ conversation: { implicitReplies: false } });

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                configValue: { conversation: { implicitReplies: false } },
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            }),
        );
    });

    it('leaves other keys on the untyped path', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };
        const controller = buildController(
            { createOrUpdateParametersUseCase },
            request,
        );

        await controller.createOrUpdate({
            key: ParametersKey.LANGUAGE_CONFIG,
            configValue: 'pt-BR',
            organizationAndTeamData: { teamId: 'team-1' },
        });

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.LANGUAGE_CONFIG,
            'pt-BR',
            { organizationId: 'org-1', teamId: 'team-1' },
        );
    });
});
