import { PullRequestMessagesLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/pullRequestMessageLog.handler';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

const MOCK_DEFAULT_MESSAGES = {
    customMessages: {
        startReviewMessage: { content: 'Default start message' },
        endReviewMessage: { content: 'Default end message' },
        globalSettings: {
            hideComments: false,
            suggestionCopyPrompt: true,
        },
    },
};

jest.mock('@libs/common/utils/validateCodeReviewConfigFile', () => ({
    getDefaultKodusConfigFile: () => ({ ...MOCK_DEFAULT_MESSAGES }),
}));

describe('PullRequestMessagesLogHandler', () => {
    let handler: PullRequestMessagesLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new PullRequestMessagesLogHandler(mockUnified as any);
    });

    const callHandler = (overrides: any) =>
        handler.logPullRequestMessagesAction({
            ...createBaseParams(),
            configLevel: ConfigLevel.GLOBAL,
            isUpdate: false,
            ...overrides,
        } as any);

    // ─── Start/End messages (create path) ───

    describe('create path (isUpdate=false)', () => {
        it('creates entry when content differs from default', async () => {
            await callHandler({
                startReviewMessage: {
                    content: 'Custom start',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Start Review Message Updated',
            );
            expect(data[0].description).toContain(
                'changed default start review message',
            );
        });

        it('creates deactivation entry when status inactive with default content', async () => {
            await callHandler({
                startReviewMessage: {
                    content: 'Default start message',
                    status: 'inactive',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('deactivated');
        });

        it('no entry when content matches default + active', async () => {
            await callHandler({
                startReviewMessage: {
                    content: 'Default start message',
                    status: 'active',
                },
            });

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── Start/End messages (update path) ───

    describe('update path (isUpdate=true)', () => {
        it('detects content change only', async () => {
            await callHandler({
                isUpdate: true,
                startReviewMessage: {
                    content: 'New content',
                    status: 'active',
                },
                existingStartMessage: {
                    content: 'Old content',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'updated start review message content',
            );
        });

        it('detects status change only', async () => {
            await callHandler({
                isUpdate: true,
                startReviewMessage: {
                    content: 'Same content',
                    status: 'inactive',
                },
                existingStartMessage: {
                    content: 'Same content',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('deactivated');
        });

        it('detects both content + status change', async () => {
            await callHandler({
                isUpdate: true,
                startReviewMessage: {
                    content: 'New content',
                    status: 'inactive',
                },
                existingStartMessage: {
                    content: 'Old content',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('updated content');
            expect(data[0].description).toContain('deactivated');
        });

        it('no entry when nothing changed', async () => {
            await callHandler({
                isUpdate: true,
                startReviewMessage: {
                    content: 'Same',
                    status: 'active',
                },
                existingStartMessage: {
                    content: 'Same',
                    status: 'active',
                },
            });

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── Global settings ───

    describe('global settings', () => {
        it('detects hideComments toggle', async () => {
            await callHandler({
                isUpdate: true,
                globalSettings: { hideComments: true },
                existingGlobalSettings: { hideComments: false },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Global Setting Updated: Post as Hidden Comment',
            );
            expect(data[0].description).toContain('enabled');
        });

        it('detects suggestionCopyPrompt toggle', async () => {
            await callHandler({
                isUpdate: true,
                globalSettings: { suggestionCopyPrompt: false },
                existingGlobalSettings: { suggestionCopyPrompt: true },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Global Setting Updated: Enable LLM Prompt',
            );
        });

        it('uses defaults when isUpdate=false', async () => {
            // default hideComments is false, so changing to true should be detected
            await callHandler({
                isUpdate: false,
                globalSettings: { hideComments: true },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('enabled');
        });

        it('no entry when nothing changed', async () => {
            await callHandler({
                isUpdate: true,
                globalSettings: { hideComments: false },
                existingGlobalSettings: { hideComments: false },
            });

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── Combined changes ───

    describe('combined', () => {
        it('produces multiple entries for start + end + globalSettings', async () => {
            await callHandler({
                isUpdate: true,
                startReviewMessage: {
                    content: 'New start',
                    status: 'active',
                },
                existingStartMessage: {
                    content: 'Old start',
                    status: 'active',
                },
                endReviewMessage: {
                    content: 'New end',
                    status: 'active',
                },
                existingEndMessage: {
                    content: 'Old end',
                    status: 'active',
                },
                globalSettings: { hideComments: true },
                existingGlobalSettings: { hideComments: false },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(3);
        });
    });

    // ─── Config level descriptions ───

    describe('config level descriptions', () => {
        it('GLOBAL → "at global level"', async () => {
            await callHandler({
                configLevel: ConfigLevel.GLOBAL,
                startReviewMessage: {
                    content: 'Custom',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data[0].description).toContain('at global level');
        });

        it('REPOSITORY → "for repository <id>"', async () => {
            await callHandler({
                configLevel: ConfigLevel.REPOSITORY,
                repositoryId: 'repo-123',
                startReviewMessage: {
                    content: 'Custom',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data[0].description).toContain('for repository repo-123');
        });

        it('DIRECTORY → "for directory <path>"', async () => {
            await callHandler({
                configLevel: ConfigLevel.DIRECTORY,
                directoryPath: '/src/lib',
                startReviewMessage: {
                    content: 'Custom',
                    status: 'active',
                },
            });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data[0].description).toContain('for directory /src/lib');
        });
    });
});
