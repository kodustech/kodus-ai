import { CliKeyLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/cliKeyLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

describe('CliKeyLogHandler', () => {
    let handler: CliKeyLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new CliKeyLogHandler(mockUnified as any);
    });

    it('ActionType.CREATE → CLI Key Created', async () => {
        await handler.logCliKeyAction({
            ...createBaseParams({ actionType: ActionType.CREATE }),
            keyName: 'my-key',
        } as any);

        const data = extractChangedData(mockUnified.saveLogEntry);
        expect(data).toHaveLength(1);
        expect(data[0].actionDescription).toBe('CLI Key Created');
        expect(data[0].previousValue).toBeNull();
        expect(data[0].currentValue).toEqual({ name: 'my-key' });
        expect(data[0].description).toContain('created CLI key "my-key"');

        const call = mockUnified.saveLogEntry.mock.calls[0][0];
        expect(call.configLevel).toBe(ConfigLevel.GLOBAL);
    });

    it('ActionType.DELETE → CLI Key Revoked', async () => {
        await handler.logCliKeyAction({
            ...createBaseParams({ actionType: ActionType.DELETE }),
            keyName: 'old-key',
        } as any);

        const data = extractChangedData(mockUnified.saveLogEntry);
        expect(data).toHaveLength(1);
        expect(data[0].actionDescription).toBe('CLI Key Revoked');
        expect(data[0].previousValue).toEqual({ name: 'old-key' });
        expect(data[0].currentValue).toBeNull();
        expect(data[0].description).toContain('revoked CLI key "old-key"');
    });

    it('other actionType → saveLogEntry not called', async () => {
        await handler.logCliKeyAction({
            ...createBaseParams({ actionType: ActionType.EDIT }),
            keyName: 'key',
        } as any);

        expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
    });
});
