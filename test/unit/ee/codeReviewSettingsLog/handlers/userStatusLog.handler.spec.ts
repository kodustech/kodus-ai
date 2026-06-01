import { UserStatusLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/userStatusLog.handler';

import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

describe('UserStatusLogHandler', () => {
    let handler: UserStatusLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new UserStatusLogHandler(mockUnified as any);
    });

    it('creates one entry per status change', async () => {
        await handler.logUserStatusChanges({
            ...createBaseParams(),
            userStatusChanges: [
                {
                    gitId: 'git-1',
                    gitTool: 'github',
                    userName: 'Alice',
                    licenseStatus: true,
                },
                {
                    gitId: 'git-2',
                    gitTool: 'github',
                    userName: 'Bob',
                    licenseStatus: false,
                },
            ],
        } as any);

        const data = extractChangedData(mockUnified.saveLogEntry);
        expect(data).toHaveLength(2);

        expect(data[0].actionDescription).toBe('User Enabled');
        expect(data[0].currentValue.status).toBe('active');
        expect(data[0].description).toContain(
            'enabled license for user "Alice"',
        );

        expect(data[1].actionDescription).toBe('User Disabled');
        expect(data[1].currentValue.status).toBe('inactive');
        expect(data[1].description).toContain(
            'disabled license for user "Bob"',
        );
    });

    it('licenseStatus true → "active", false → "inactive"', async () => {
        await handler.logUserStatusChanges({
            ...createBaseParams(),
            userStatusChanges: [
                {
                    gitId: 'g1',
                    gitTool: 'github',
                    userName: 'User',
                    licenseStatus: true,
                },
            ],
        } as any);

        const data = extractChangedData(mockUnified.saveLogEntry);
        expect(data[0].currentValue.status).toBe('active');
    });

    it('does not call saveLogEntry with empty array', async () => {
        await handler.logUserStatusChanges({
            ...createBaseParams(),
            userStatusChanges: [],
        } as any);

        expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
    });
});
