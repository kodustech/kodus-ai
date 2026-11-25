import { SendRulesNotificationUseCase } from './send-rules-notification.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('SendRulesNotificationUseCase per Git connection', () => {
    it('tells each member only about the rules of repositories they can read', async () => {
        const users = [
            { uuid: 'owner', role: 'owner', email: 'o@example.test' },
            { uuid: 'member', role: 'contributor', email: 'm@example.test' },
        ];
        const notificationService = {
            emit: jest.fn().mockResolvedValue(undefined),
        };
        const connectionAccess = {
            restrictionFor: jest.fn(async (user: { uuid: string }) =>
                user.uuid === 'member'
                    ? {
                          connectionIds: new Set(['gh-a']),
                          repositoryIds: new Set(['repo-gh']),
                          allowsRepository: ({ id }: { id?: unknown }) =>
                              id === 'repo-gh',
                      }
                    : null,
            ),
        };
        const useCase = new SendRulesNotificationUseCase(
            { find: jest.fn().mockResolvedValue(users) } as any,
            { findOne: jest.fn().mockResolvedValue({ name: 'Acme' }) } as any,
            notificationService as any,
            connectionAccess as any,
        );

        await useCase.execute('org-1', [
            { title: 'GitHub rule', repositoryId: 'repo-gh' },
            { title: 'GitLab rule', repositoryId: 'repo-gl' },
        ]);

        const sent = notificationService.emit.mock.calls.map(([message]) => ({
            recipients: message.recipients.map(
                (r: { userId: string }) => r.userId,
            ),
            rules: message.payload.rules,
        }));
        expect(sent).toEqual(
            expect.arrayContaining([
                {
                    recipients: ['owner'],
                    rules: ['GitHub rule', 'GitLab rule'],
                },
                { recipients: ['member'], rules: ['GitHub rule'] },
            ]),
        );
        expect(sent).toHaveLength(2);
    });

    it('keeps sending plain rule titles to everyone, as before', async () => {
        const notificationService = {
            emit: jest.fn().mockResolvedValue(undefined),
        };
        const useCase = new SendRulesNotificationUseCase(
            {
                find: jest
                    .fn()
                    .mockResolvedValue([
                        { uuid: 'u', email: 'u@example.test' },
                    ]),
            } as any,
            { findOne: jest.fn().mockResolvedValue({ name: 'Acme' }) } as any,
            notificationService as any,
        );

        await useCase.execute('org-1', ['A rule']);

        expect(notificationService.emit).toHaveBeenCalledTimes(1);
        expect(notificationService.emit.mock.calls[0][0].payload.rules).toEqual(
            ['A rule'],
        );
    });
});
