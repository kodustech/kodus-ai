import { IntegrationLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/integrationLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    createMockUnifiedLogHandler,
    createBaseParams,
} from './helpers/shared-mocks';

describe('IntegrationLogHandler', () => {
    let handler: IntegrationLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new IntegrationLogHandler(mockUnified as any);
    });

    const makeIntegration = (overrides: any = {}) => ({
        platform: 'GITHUB',
        integrationCategory: 'code_management',
        authIntegration: {
            authDetails: {
                org: 'my-org',
                accountType: 'organization',
                authMode: 'oauth',
            },
        },
        ...overrides,
    });

    it('CREATE → logAction with newData set, oldData=null', async () => {
        await handler.logIntegrationAction({
            ...createBaseParams({ actionType: ActionType.CREATE }),
            integration: makeIntegration(),
        } as any);

        expect(mockUnified.logAction).toHaveBeenCalledTimes(1);
        const call = mockUnified.logAction.mock.calls[0][0];
        expect(call.configLevel).toBe(ConfigLevel.GLOBAL);
        expect(call.entityType).toBe('integration');
        expect(call.entityName).toContain('GitHub');
        expect(call.entityName).toContain('my-org');
        expect(call.newData).toBeTruthy();
        expect(call.newData.platform).toBe('GITHUB');
        expect(call.oldData).toBeNull();
    });

    it('DELETE → oldData set, newData=null', async () => {
        await handler.logIntegrationAction({
            ...createBaseParams({ actionType: ActionType.DELETE }),
            integration: makeIntegration(),
        } as any);

        const call = mockUnified.logAction.mock.calls[0][0];
        expect(call.oldData).toBeTruthy();
        expect(call.newData).toBeNull();
    });

    it('formats platform names correctly', async () => {
        const platforms = [
            { input: 'GITHUB', expected: 'GitHub' },
            { input: 'GITLAB', expected: 'GitLab' },
            { input: 'BITBUCKET', expected: 'Bitbucket' },
            { input: 'AZURE', expected: 'Azure DevOps' },
        ];

        for (const { input, expected } of platforms) {
            mockUnified.logAction.mockClear();

            await handler.logIntegrationAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                integration: makeIntegration({ platform: input }),
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.entityName).toContain(expected);
        }
    });
});
