import { UnifiedLogHandler } from './unifiedLog.handler';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

/**
 * Mutation-killing unit tests for the deterministic, dependency-free logic in
 * UnifiedLogHandler:
 *   - generateChangedData / generateActionDescription / generateDescription /
 *     capitalizeFirstLetter (private instance methods, reached via `as any`)
 *   - hasChanged / isEqual / formatValue (static methods)
 *
 * The constructor takes two injected deps that NONE of these methods touch, so
 * we build the instance with inert stubs. Every assertion pins an EXACT value
 * (deep equality, exact string), exercises both sides of each branch, and pins
 * the boundaries (length equal / not equal, key-count equal / not equal, the
 * `||`/`??`-style fallbacks with inputs that actually trigger the fallback).
 */
describe('UnifiedLogHandler deterministic logic', () => {
    let handler: UnifiedLogHandler;

    beforeEach(() => {
        handler = new UnifiedLogHandler({} as any, {} as any);
    });

    describe('capitalizeFirstLetter', () => {
        const cap = (s: string): string =>
            (handler as any).capitalizeFirstLetter(s);

        it('uppercases the first character and preserves the rest', () => {
            expect(cap('hello')).toBe('Hello');
        });

        it('uppercases a single lowercase character', () => {
            expect(cap('a')).toBe('A');
        });

        it('leaves an already-capitalized string unchanged', () => {
            expect(cap('Hello')).toBe('Hello');
        });

        it('returns empty string for empty input (no crash on charAt(0))', () => {
            expect(cap('')).toBe('');
        });

        it('does not alter a string starting with a digit', () => {
            expect(cap('123abc')).toBe('123abc');
        });
    });

    describe('generateActionDescription', () => {
        const desc = (entityType: string, action: ActionType): string =>
            (handler as any).generateActionDescription(entityType, action);

        it('maps kodyRule + CREATE to "Kody Rule Created"', () => {
            expect(desc('kodyRule', ActionType.CREATE)).toBe(
                'Kody Rule Created',
            );
        });

        it('maps config + EDIT to "Configuration Edited"', () => {
            expect(desc('config', ActionType.EDIT)).toBe(
                'Configuration Edited',
            );
        });

        it('maps repository + DELETE to "Repository Deleted"', () => {
            expect(desc('repository', ActionType.DELETE)).toBe(
                'Repository Deleted',
            );
        });

        it('maps integration + ADD to "Integration Added"', () => {
            expect(desc('integration', ActionType.ADD)).toBe(
                'Integration Added',
            );
        });

        it('maps user + CREATE to "User Created"', () => {
            expect(desc('user', ActionType.CREATE)).toBe('User Created');
        });

        it('falls back to capitalizeFirstLetter for an unknown entity type', () => {
            // "workflow" is not in entityDisplayNames -> capitalized fallback.
            expect(desc('workflow', ActionType.CREATE)).toBe(
                'Workflow Created',
            );
        });

        it('falls back to the raw actionType for an unmapped action (CLONE)', () => {
            // CLONE is absent from actionDisplayNames -> raw enum value 'clone'.
            expect(desc('kodyRule', ActionType.CLONE)).toBe('Kody Rule clone');
        });
    });

    describe('generateDescription', () => {
        const desc = (
            action: ActionType,
            entityType: string,
            entityName: string | undefined,
            userEmail: string,
        ): string =>
            (handler as any).generateDescription(
                action,
                entityType,
                entityName,
                userEmail,
            );

        it('uses the mapped verb and quotes the entity name when present', () => {
            expect(
                desc(ActionType.CREATE, 'kodyRule', 'My Rule', 'a@b.com'),
            ).toBe('User a@b.com created "My Rule"');
        });

        it('maps EDIT to "edited"', () => {
            expect(desc(ActionType.EDIT, 'config', 'Cfg', 'x@y.com')).toBe(
                'User x@y.com edited "Cfg"',
            );
        });

        it('maps DELETE to "deleted"', () => {
            expect(desc(ActionType.DELETE, 'config', 'Cfg', 'x@y.com')).toBe(
                'User x@y.com deleted "Cfg"',
            );
        });

        it('maps ADD to "added"', () => {
            expect(desc(ActionType.ADD, 'config', 'Cfg', 'x@y.com')).toBe(
                'User x@y.com added "Cfg"',
            );
        });

        it('uses the bare entityType (no quotes) when entityName is undefined', () => {
            expect(desc(ActionType.EDIT, 'config', undefined, 'x@y.com')).toBe(
                'User x@y.com edited config',
            );
        });

        it('treats an empty entityName as absent and uses the entityType', () => {
            expect(desc(ActionType.EDIT, 'config', '', 'x@y.com')).toBe(
                'User x@y.com edited config',
            );
        });

        it('falls back to lowercased actionType for an unmapped action (CLONE)', () => {
            expect(desc(ActionType.CLONE, 'kodyRule', 'R', 'e@e.com')).toBe(
                'User e@e.com clone "R"',
            );
        });
    });

    describe('generateChangedData', () => {
        const gen = (params: any): any =>
            (handler as any).generateChangedData(params);

        it('composes the full entry with provided old/new data (deep equal)', () => {
            const oldData = { enabled: true };
            const newData = { enabled: false };
            const result = gen({
                actionType: ActionType.EDIT,
                entityType: 'config',
                entityName: 'My Config',
                oldData,
                newData,
                userInfo: { userId: 'u1', userEmail: 'user@kodus.io' },
            });

            expect(result).toEqual([
                {
                    actionDescription: 'Configuration Edited',
                    previousValue: oldData,
                    currentValue: newData,
                    description: 'User user@kodus.io edited "My Config"',
                },
            ]);
        });

        it('coalesces missing oldData/newData to null', () => {
            const result = gen({
                actionType: ActionType.CREATE,
                entityType: 'kodyRule',
                entityName: undefined,
                oldData: undefined,
                newData: undefined,
                userInfo: { userId: 'u1', userEmail: 'a@b.com' },
            });

            expect(result).toEqual([
                {
                    actionDescription: 'Kody Rule Created',
                    previousValue: null,
                    currentValue: null,
                    description: 'User a@b.com created kodyRule',
                },
            ]);
        });

        it('returns exactly one entry', () => {
            const result = gen({
                actionType: ActionType.ADD,
                entityType: 'user',
                entityName: 'Bob',
                oldData: { x: 1 },
                newData: { x: 2 },
                userInfo: { userId: 'u1', userEmail: 'a@b.com' },
            });
            expect(result).toHaveLength(1);
        });
    });

    describe('formatValue (static)', () => {
        const fmt = UnifiedLogHandler.formatValue;

        it('returns "none" for null', () => {
            expect(fmt(null)).toBe('none');
        });

        it('returns "none" for undefined', () => {
            expect(fmt(undefined)).toBe('none');
        });

        it('returns "enabled" for boolean true', () => {
            expect(fmt(true)).toBe('enabled');
        });

        it('returns "disabled" for boolean false', () => {
            expect(fmt(false)).toBe('disabled');
        });

        it('joins a non-empty array with ", "', () => {
            expect(fmt(['a', 'b', 'c'])).toBe('a, b, c');
        });

        it('returns "none" for an empty array (join yields empty string)', () => {
            expect(fmt([])).toBe('none');
        });

        it('JSON-stringifies a plain object', () => {
            expect(fmt({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
        });

        it('stringifies a number (not treated as none/disabled at 0)', () => {
            expect(fmt(0)).toBe('0');
            expect(fmt(42)).toBe('42');
        });

        it('returns a plain string unchanged, including empty string', () => {
            expect(fmt('hello')).toBe('hello');
            expect(fmt('')).toBe('');
        });
    });

    describe('hasChanged (static)', () => {
        // Keep the class as `this` — hasChanged calls `this.isEqual` internally.
        const changed = (a: any, b: any): boolean =>
            UnifiedLogHandler.hasChanged(a, b);

        it('returns false for strictly-equal primitives', () => {
            expect(changed(5, 5)).toBe(false);
            expect(changed('x', 'x')).toBe(false);
        });

        it('returns true for differing primitives', () => {
            expect(changed(1, 2)).toBe(true);
            expect(changed('a', 'b')).toBe(true);
        });

        it('returns false for two arrays with equal length and equal items', () => {
            expect(changed([1, 2, 3], [1, 2, 3])).toBe(false);
        });

        it('returns true for two arrays of different length', () => {
            expect(changed([1, 2], [1, 2, 3])).toBe(true);
        });

        it('returns true for same-length arrays with one differing item', () => {
            expect(changed([1, 2, 3], [1, 9, 3])).toBe(true);
        });

        it('compares array items deeply (nested objects equal -> false)', () => {
            expect(changed([{ a: 1 }], [{ a: 1 }])).toBe(false);
            expect(changed([{ a: 1 }], [{ a: 2 }])).toBe(true);
        });

        it('returns false for two objects with equal keys and values', () => {
            expect(changed({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(false);
        });

        it('returns true for objects with a different number of keys', () => {
            expect(changed({ a: 1 }, { a: 1, b: 2 })).toBe(true);
        });

        it('returns true for same-key objects with a differing value', () => {
            expect(changed({ a: 1 }, { a: 2 })).toBe(true);
        });

        it('returns true when one side is null and the other is an object', () => {
            expect(changed(null, { a: 1 })).toBe(true);
        });

        it('returns false when both sides are null (strict equality short-circuit)', () => {
            expect(changed(null, null)).toBe(false);
        });

        it('returns true when comparing an array to a plain object of different key count', () => {
            // [1,2] -> keys ['0','1'] (len 2); {a:1} -> ['a'] (len 1).
            expect(changed([1, 2], { a: 1 } as any)).toBe(true);
        });
    });

    describe('isEqual (private static)', () => {
        const isEqual = (a: any, b: any): boolean =>
            (UnifiedLogHandler as any).isEqual(a, b);

        it('returns true for strictly-equal primitives', () => {
            expect(isEqual(1, 1)).toBe(true);
            expect(isEqual('x', 'x')).toBe(true);
            expect(isEqual(null, null)).toBe(true);
        });

        it('returns false for differing primitives', () => {
            expect(isEqual(1, 2)).toBe(false);
        });

        it('returns true for arrays of equal length and equal items', () => {
            expect(isEqual([1, 2], [1, 2])).toBe(true);
        });

        it('returns false for arrays of different length', () => {
            expect(isEqual([1], [1, 2])).toBe(false);
        });

        it('returns false for same-length arrays with a differing item', () => {
            expect(isEqual([1, 2], [1, 3])).toBe(false);
        });

        it('returns true for objects with equal keys and values', () => {
            expect(isEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
        });

        it('returns false for objects with a different number of keys', () => {
            expect(isEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        });

        it('returns false for same-key objects with a differing value', () => {
            expect(isEqual({ a: 1 }, { a: 2 })).toBe(false);
        });

        it('recurses into nested arrays inside objects', () => {
            expect(isEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
            expect(isEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
        });

        it('returns false when an object is compared to a primitive', () => {
            expect(isEqual({ a: 1 }, 1)).toBe(false);
        });

        it('returns false when one side is null and the other is an object', () => {
            expect(isEqual(null, { a: 1 })).toBe(false);
        });
    });
});
