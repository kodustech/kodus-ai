import { CreateOrUpdateParametersUseCase } from './create-or-update-use-case';
import { DeleteRepositoryCodeReviewParameterUseCase } from './delete-repository-code-review-parameter.use-case';
import { FindByKeyParametersUseCase } from './find-by-key-use-case';
import { GenerateKodusConfigFileUseCase } from './generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from './get-code-review-parameter.use-case';
import { GetDefaultConfigUseCase } from './get-default-config.use-case';
import { ListCodeReviewAutomationLabelsUseCase } from './list-code-review-automation-labels-use-case';
import { ListCodeReviewAutomationLabelsWithStatusUseCase } from './list-code-review-automation-labels-with-status.use-case';
import { PreviewPrSummaryUseCase } from './preview-pr-summary.use-case';
import { UpdateCodeReviewParameterRepositoriesUseCase } from './update-code-review-parameter-repositories-use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from './update-or-create-code-review-parameter-use-case';
import { ApplyCodeReviewPresetUseCase } from './apply-code-review-preset.use-case';

export const UseCases = [
    CreateOrUpdateParametersUseCase,
    FindByKeyParametersUseCase,
    ListCodeReviewAutomationLabelsUseCase,
    UpdateOrCreateCodeReviewParameterUseCase,
    UpdateCodeReviewParameterRepositoriesUseCase,
    GenerateKodusConfigFileUseCase,
    DeleteRepositoryCodeReviewParameterUseCase,
    PreviewPrSummaryUseCase,
    ListCodeReviewAutomationLabelsWithStatusUseCase,
    GetDefaultConfigUseCase,
    GetCodeReviewParameterUseCase,
    ApplyCodeReviewPresetUseCase,
];
