import { KodyRulesLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/kodyRulesLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    createMockUnifiedLogHandler,
    createBaseParams,
} from './helpers/shared-mocks';

describe('KodyRulesLogHandler', () => {
    let handler: KodyRulesLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new KodyRulesLogHandler(mockUnified as any);
    });

    // ─── Config level ───

    describe('config level determination', () => {
        it('no repo → GLOBAL', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                newRule: { title: 'Rule A' },
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.configLevel).toBe(ConfigLevel.GLOBAL);
        });

        it('repo with id="global" → GLOBAL', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                repository: { id: 'global' },
                newRule: { title: 'Rule A' },
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.configLevel).toBe(ConfigLevel.GLOBAL);
        });

        it('repo → REPOSITORY', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                repository: { id: 'repo-1' },
                newRule: { title: 'Rule A' },
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.configLevel).toBe(ConfigLevel.REPOSITORY);
        });

        it('directory → DIRECTORY', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                repository: { id: 'repo-1' },
                directory: { id: 'dir-1' },
                newRule: { title: 'Rule A' },
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.configLevel).toBe(ConfigLevel.DIRECTORY);
        });
    });

    // ─── Rule name fallback ───

    describe('rule name fallback chain', () => {
        it('uses newRule.title first', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                newRule: { title: 'New Title' },
                oldRule: { title: 'Old Title' },
                ruleTitle: 'Param Title',
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.entityName).toBe('New Title');
        });

        it('falls back to oldRule.title', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.DELETE }),
                oldRule: { title: 'Old Title' },
                ruleTitle: 'Param Title',
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.entityName).toBe('Old Title');
        });

        it('falls back to ruleTitle', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.DELETE }),
                ruleTitle: 'Param Title',
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.entityName).toBe('Param Title');
        });

        it('falls back to "Unnamed Rule"', async () => {
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.DELETE }),
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.entityName).toBe('Unnamed Rule');
        });
    });

    // ─── Data by actionType ───

    describe('data by actionType', () => {
        it('CREATE → oldData=null, newData=newRule', async () => {
            const newRule = { title: 'Rule', rule: 'Do X' };
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.CREATE }),
                newRule,
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.oldData).toBeNull();
            expect(call.newData).toBe(newRule);
        });

        it('DELETE → oldData=oldRule, newData=null', async () => {
            const oldRule = { title: 'Rule', rule: 'Do X' };
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.DELETE }),
                oldRule,
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.oldData).toBe(oldRule);
            expect(call.newData).toBeNull();
        });

        it('EDIT → oldData=oldRule, newData=newRule', async () => {
            const oldRule = { title: 'Old', rule: 'Do X' };
            const newRule = { title: 'New', rule: 'Do Y' };
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.EDIT }),
                oldRule,
                newRule,
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.oldData).toBe(oldRule);
            expect(call.newData).toBe(newRule);
        });

        it('ADD → oldData=null, newData=newRule', async () => {
            const newRule = { title: 'Rule', rule: 'Do X' };
            await handler.logKodyRuleAction({
                ...createBaseParams({ actionType: ActionType.ADD }),
                newRule,
            } as any);

            const call = mockUnified.logAction.mock.calls[0][0];
            expect(call.oldData).toBeNull();
            expect(call.newData).toBe(newRule);
        });
    });
});
