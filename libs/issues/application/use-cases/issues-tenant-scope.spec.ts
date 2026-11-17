import { GetIssuesUseCase } from './get-issues.use-case';
import { GetTotalIssuesUseCase } from './get-total-issues.use-case';

/**
 * Tenant isolation — `GET /issues` and `GET /issues/count` take an optional
 * `organizationId` query parameter. The organization must always come from
 * the authenticated principal; a client-supplied one must never select
 * another organization's issues.
 */
describe('issues — organizationId comes from the principal', () => {
    const principalOrg = 'my-org';
    const victimOrg = 'victim-org';

    const request: any = {
        user: { uuid: 'u1', organization: { uuid: principalOrg } },
    };
    // Owner/admin: no repository restriction.
    const authorizationService: any = {
        getRepositoryScope: jest.fn().mockResolvedValue(null),
    };

    it('GET /issues ignores a query-supplied organizationId', async () => {
        const issuesService: any = { find: jest.fn().mockResolvedValue([]) };
        const cacheService: any = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn(),
        };
        const useCase = new GetIssuesUseCase(
            issuesService,
            request,
            cacheService,
            authorizationService,
        );

        await useCase.execute({ organizationId: victimOrg } as any);

        expect(issuesService.find).toHaveBeenCalledWith(principalOrg);
        expect(cacheService.getFromCache).not.toHaveBeenCalledWith(
            `issues_${victimOrg}`,
        );
    });

    it('GET /issues/count ignores a query-supplied organizationId', async () => {
        const issuesService: any = { count: jest.fn().mockResolvedValue(0) };
        const kodyIssuesManagementService: any = {
            buildFilter: jest.fn(async (filters) => filters),
        };
        const useCase = new GetTotalIssuesUseCase(
            issuesService,
            kodyIssuesManagementService,
            request,
            authorizationService,
        );

        await useCase.execute({ organizationId: victimOrg } as any);

        expect(kodyIssuesManagementService.buildFilter).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: principalOrg }),
        );
    });
});
