import { UserInviteLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/userInviteLog.handler';

import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

describe('UserInviteLogHandler', () => {
    let handler: UserInviteLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new UserInviteLogHandler(mockUnified as any);
    });

    it('generates entries only for invite_sent status', async () => {
        await handler.logUserInviteAction({
            ...createBaseParams(),
            invitedUsers: [
                { email: 'a@test.com', status: 'invite_sent' },
                {
                    email: 'b@test.com',
                    status: 'user_already_registered_in_other_organization',
                },
            ],
        } as any);

        const data = extractChangedData(mockUnified.saveLogEntry);
        expect(data).toHaveLength(1);
        expect(data[0].actionDescription).toBe('User Invited');
        expect(data[0].currentValue.email).toBe('a@test.com');
        expect(data[0].description).toContain('invited "a@test.com"');
    });

    it('creates one entry per successful invite', async () => {
        await handler.logUserInviteAction({
            ...createBaseParams(),
            invitedUsers: [
                { email: 'a@test.com', status: 'invite_sent' },
                { email: 'b@test.com', status: 'invite_sent' },
                { email: 'c@test.com', status: 'invite_sent' },
            ],
        } as any);

        const data = extractChangedData(mockUnified.saveLogEntry);
        expect(data).toHaveLength(3);
    });

    it('does not call saveLogEntry when no invite_sent', async () => {
        await handler.logUserInviteAction({
            ...createBaseParams(),
            invitedUsers: [
                {
                    email: 'a@test.com',
                    status: 'user_already_registered_in_other_organization',
                },
            ],
        } as any);

        expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
    });

    it('does not call saveLogEntry with empty array', async () => {
        await handler.logUserInviteAction({
            ...createBaseParams(),
            invitedUsers: [],
        } as any);

        expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
    });
});
