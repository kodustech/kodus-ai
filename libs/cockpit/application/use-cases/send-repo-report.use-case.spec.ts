jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

import { SendRepoReportUseCase } from './send-repo-report.use-case';

describe('SendRepoReportUseCase', () => {
    let organizationService: any;
    let recipients: any;
    let reports: any;
    let notificationService: any;
    let configService: any;
    let useCase: SendRepoReportUseCase;

    const INPUT = {
        organizationId: 'org-1',
        startDate: '2026-06-01',
        endDate: '2026-06-15',
    };

    beforeEach(() => {
        organizationService = {
            findOne: jest.fn().mockResolvedValue({
                uuid: 'org-1',
                name: 'Acme',
            }),
        };
        recipients = { getRepoAdmins: jest.fn() };
        reports = { buildRepoSections: jest.fn() };
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        configService = { get: jest.fn().mockReturnValue(undefined) };
        useCase = new SendRepoReportUseCase(
            organizationService,
            recipients,
            reports,
            notificationService,
            configService,
        );
    });

    it('skips when the org is not found', async () => {
        organizationService.findOne.mockResolvedValue(null);

        const result = await useCase.execute(INPUT);

        expect(result.skipped).toBe('org-not-found');
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('skips when there are no repo admins', async () => {
        recipients.getRepoAdmins.mockResolvedValue([]);

        const result = await useCase.execute(INPUT);

        expect(result.skipped).toBe('no-recipients');
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('skips (no email) when every admin digest is empty', async () => {
        recipients.getRepoAdmins.mockResolvedValue([
            { email: 'a@acme.com', name: 'A', repositories: ['acme/x'] },
        ]);
        reports.buildRepoSections.mockResolvedValue([]); // all repos quiet

        const result = await useCase.execute(INPUT);

        expect(result.skipped).toBe('no-activity');
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('emits one digest per admin that has activity', async () => {
        recipients.getRepoAdmins.mockResolvedValue([
            { email: 'a@acme.com', name: 'A', repositories: ['acme/x'] },
            { email: 'b@acme.com', name: 'B', repositories: ['acme/y'] },
        ]);
        reports.buildRepoSections.mockImplementation(
            (_org: string, repos: string[]) =>
                repos[0] === 'acme/x'
                    ? Promise.resolve([{ repository: 'acme/x' }])
                    : Promise.resolve([]),
        );

        const result = await useCase.execute(INPUT);

        expect(result.skipped).toBeUndefined();
        expect(result.sent).toBe(1);
        expect(notificationService.emit).toHaveBeenCalledTimes(1);
        const emitted = notificationService.emit.mock.calls[0][0];
        expect(emitted.event).toBe('cockpit.repo_report');
        expect(emitted.recipients).toEqual({
            kind: 'email',
            email: 'a@acme.com',
        });
        const emittedSections = (emitted.payload.props as any).sections;
        expect(emittedSections).toHaveLength(1);
        expect(emittedSections[0].repository).toBe('acme/x');
        // Each section carries a repo-scoped cockpit deep link.
        expect(emittedSections[0].cockpitLink).toContain(
            'repository=acme%2Fx',
        );
    });
});
