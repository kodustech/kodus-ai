import { SavePullRequestUseCase } from './save.use-case';
import { GetPullRequestAuthorsUseCase } from './get-pull-request-authors-orderedby-contributions.use-case';
import { UpdatePullRequestToNewFormatUseCase } from './update-pull-request-to-new-format.use-case';

export const UseCases = [
    SavePullRequestUseCase,
    GetPullRequestAuthorsUseCase,
    UpdatePullRequestToNewFormatUseCase
];
