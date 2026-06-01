import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { GetIssueByIdUseCase } from '@libs/issues/application/use-cases/get-issue-by-id.use-case';

describe('GetIssueByIdUseCase', () => {
    const makeUseCase = () =>
        new GetIssueByIdUseCase(
            undefined as any,
            undefined as any,
            undefined as any,
            undefined as any,
            undefined as any,
            undefined as any,
        );

    it('uses the enterprise origin even when the stored repository url has no path', () => {
        const useCase = makeUseCase() as any;

        const repositoryUrl = useCase.buildRepositoryUrl({
            platform: PlatformType.GITHUB,
            repositoryFullName: 'acme/repo',
            httpUrl: 'https://github.enterprise.com/acme/repo.git',
            repositoryUrl: 'https://github.enterprise.com',
        });

        expect(repositoryUrl).toBe('https://github.enterprise.com/acme/repo');
    });
});
