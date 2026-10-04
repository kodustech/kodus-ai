import { NotFoundException } from '@nestjs/common';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { GetIssueByIdUseCase } from '@libs/issues/application/use-cases/get-issue-by-id.use-case';
import { UpdateIssuePropertyUseCase } from '@libs/issues/application/use-cases/update-issue-property.use-case';

// The issue lookups take the id from the path, and the repository-scoped
// authorization check builds its subject from the CALLER's organization, so
// it never compared the issue's own organization. An owner (no repository
// restriction) passed it for an issue of any organization.
describe('Issue use cases — organization isolation', () => {
    const FOREIGN_ISSUE = {
        uuid: 'issue-globex',
        organizationId: 'org-globex',
        repository: { id: 'repo-globex', url: 'https://github.com/globex/app' },
    };

    const request = {
        user: { uuid: 'owner-acme', organization: { uuid: 'org-acme' } },
    };

    const build = () => {
        const issuesService = {
            findById: jest.fn().mockResolvedValue(FOREIGN_ISSUE),
            updateSeverity: jest.fn(),
            updateLabel: jest.fn(),
            updateStatus: jest.fn(),
        };
        // An owner without repository restrictions passes this check.
        const authorizationService = { ensure: jest.fn() };
        const kodyIssuesManagementService = {
            clearIssuesCache: jest.fn(),
            enrichContributingSuggestions: jest.fn().mockResolvedValue([]),
            ageCalculation: jest.fn().mockResolvedValue(0),
        };
        const codeReviewFeedbackService = {
            getByOrganizationId: jest.fn().mockResolvedValue([]),
        };

        return {
            issuesService,
            kodyIssuesManagementService,
            codeReviewFeedbackService,
            get: new GetIssueByIdUseCase(
                issuesService as any,
                codeReviewFeedbackService as any,
                kodyIssuesManagementService as any,
                { findOne: jest.fn() } as any,
                request as any,
                authorizationService as any,
            ),
            update: new UpdateIssuePropertyUseCase(
                issuesService as any,
                kodyIssuesManagementService as any,
                request as any,
                authorizationService as any,
            ),
        };
    };

    it('does not return an issue of another organization', async () => {
        const { get, codeReviewFeedbackService } = build();

        await expect(get.execute('issue-globex')).resolves.toBeNull();
        expect(
            codeReviewFeedbackService.getByOrganizationId,
        ).not.toHaveBeenCalled();
    });

    it('does not change an issue of another organization', async () => {
        const { update, issuesService, kodyIssuesManagementService } = build();

        await expect(
            update.execute('issue-globex', 'status', 'resolved'),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(issuesService.updateStatus).not.toHaveBeenCalled();
        expect(issuesService.updateSeverity).not.toHaveBeenCalled();
        expect(issuesService.updateLabel).not.toHaveBeenCalled();
        expect(
            kodyIssuesManagementService.clearIssuesCache,
        ).not.toHaveBeenCalled();
    });

    it('returns 404 when the issue does not exist', async () => {
        const { update, issuesService } = build();
        issuesService.findById.mockResolvedValue(null);

        await expect(
            update.execute('issue-missing', 'status', 'resolved'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(issuesService.updateStatus).not.toHaveBeenCalled();
    });

    it('still returns an issue of the caller organization', async () => {
        const { get, issuesService, codeReviewFeedbackService } = build();
        issuesService.findById.mockResolvedValue({
            ...FOREIGN_ISSUE,
            uuid: 'issue-own',
            organizationId: 'org-acme',
            repository: {
                id: 'repo-acme',
                url: 'https://github.com/acme/app',
                platform: PlatformType.GITHUB,
                name: 'app',
                full_name: 'acme/app',
            },
            contributingSuggestions: [],
            filePath: 'src/app.ts',
        });

        await expect(get.execute('issue-own')).resolves.toMatchObject({
            id: 'issue-own',
        });
        expect(
            codeReviewFeedbackService.getByOrganizationId,
        ).toHaveBeenCalledWith('org-acme');
    });

    it('still updates an issue of the caller organization', async () => {
        const { update, issuesService, kodyIssuesManagementService } = build();
        issuesService.findById.mockResolvedValue({
            ...FOREIGN_ISSUE,
            organizationId: 'org-acme',
        });
        issuesService.updateStatus.mockResolvedValue({ status: 'resolved' });

        await expect(
            update.execute('issue-own', 'status', 'resolved'),
        ).resolves.toEqual({ status: 'resolved' });
        expect(issuesService.updateStatus).toHaveBeenCalledWith(
            'issue-own',
            'resolved',
        );
        expect(
            kodyIssuesManagementService.clearIssuesCache,
        ).toHaveBeenCalledWith('org-acme');
    });
});
