import { CopyCodeReviewParameterUseCase } from './copy-code-review-parameter.use-case';
import { CreateOrUpdateParametersUseCase } from './create-or-update-use-case';
import { FindByKeyParametersUseCase } from './find-by-key-use-case';
import { GenerateCodeReviewParameterUseCase } from './generate-code-review-paremeter.use-case';
import { GenerateKodusConfigFileUseCase } from './generate-kodus-config-file.use-case';
import { ListCodeReviewAutomationLabelsUseCase } from './list-code-review-automation-labels-use-case';
import { SaveArtifactsStructureUseCase } from './save-artifacts-structure.use-case';
import { UpdateCodeReviewParameterRepositoriesUseCase } from './update-code-review-parameter-repositories-use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from './update-or-create-code-review-parameter-use-case';

export const UseCases = [
    CreateOrUpdateParametersUseCase,
    FindByKeyParametersUseCase,
    ListCodeReviewAutomationLabelsUseCase,
    SaveArtifactsStructureUseCase,
    UpdateOrCreateCodeReviewParameterUseCase,
    UpdateCodeReviewParameterRepositoriesUseCase,
    GenerateKodusConfigFileUseCase,
    CopyCodeReviewParameterUseCase,
    GenerateCodeReviewParameterUseCase,
];
