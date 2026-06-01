import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { IUsersService } from '@libs/identity/domain/user/contracts/user.service.contract';

import { PrAuthorRecipientResolver } from './pr-author-recipient.resolver';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('PrAuthorRecipientResolver', () => {
    let usersService: jest.Mocked<Pick<IUsersService, 'find'>>;
    let resolver: PrAuthorRecipientResolver;

    beforeEach(() => {
        usersService = { find: jest.fn() };
        resolver = new PrAuthorRecipientResolver(
            usersService as unknown as IUsersService,
        );
    });

    it('returns null when the author has no email', async () => {
        await expect(
            resolver.resolve({ login: 'alex', email: null }, 'org-1'),
        ).resolves.toBeNull();
        expect(usersService.find).not.toHaveBeenCalled();
    });

    it('returns null and skips the lookup when the author is a bot', async () => {
        await expect(
            resolver.resolve(
                { login: 'dependabot[bot]', email: 'bot@example.com' },
                'org-1',
            ),
        ).resolves.toBeNull();
        expect(usersService.find).not.toHaveBeenCalled();
    });

    it('returns null when no active user matches the email in the org', async () => {
        usersService.find.mockResolvedValueOnce([] as any);

        const result = await resolver.resolve(
            { login: 'alex', email: 'alex@external.com' },
            'org-1',
        );

        expect(result).toBeNull();
        expect(usersService.find).toHaveBeenCalledWith(
            { email: 'alex@external.com', organization: { uuid: 'org-1' } },
            [STATUS.ACTIVE],
        );
    });

    it('returns a user-kind recipient when an active user matches', async () => {
        usersService.find.mockResolvedValueOnce([
            { uuid: 'user-99', email: 'alex@kodus.io' } as any,
        ]);

        const result = await resolver.resolve(
            { login: 'alex', email: 'alex@kodus.io' },
            'org-1',
        );

        expect(result).toEqual({ kind: 'user', userId: 'user-99' });
    });
});
