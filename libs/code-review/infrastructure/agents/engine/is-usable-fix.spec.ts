import { checkFix, isUsableFix } from './is-usable-fix';

describe('checkFix', () => {
    describe('no anchor code (PR-level / whole-file findings)', () => {
        it('does not flag an empty improvedCode when existingCode is also empty', () => {
            expect(checkFix('', '')).toBeNull();
            expect(checkFix(null, undefined)).toBeNull();
            expect(checkFix(undefined, '')).toBeNull();
        });
    });

    describe('empty', () => {
        it('flags an empty string', () => {
            expect(checkFix('const x = 1;', '')).toBe('empty');
        });

        it('flags whitespace-only', () => {
            expect(checkFix('const x = 1;', '   \n  ')).toBe('empty');
        });

        it('flags null/undefined', () => {
            expect(checkFix('const x = 1;', null)).toBe('empty');
            expect(checkFix('const x = 1;', undefined)).toBe('empty');
        });
    });

    describe('noop-fix', () => {
        it('flags byte-identical code', () => {
            const code = 'const result = data.map(x => x.value);';
            expect(checkFix(code, code)).toBe('noop-fix');
        });

        it('flags identical code after whitespace/indentation normalization', () => {
            const existingCode = '  const result = data.map(x => x.value);\n';
            const improvedCode = 'const result = data.map(x => x.value);';
            expect(checkFix(existingCode, improvedCode)).toBe('noop-fix');
        });
    });

    describe('prose-only', () => {
        it('flags a comment describing the fix instead of code', () => {
            const existingCode = 'catch (e) { console.log(e); }';
            const improvedCode =
                '// re-throw the error here instead of swallowing it';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        it('flags a plain-English sentence with no code tokens', () => {
            const existingCode = 'if (user.role === "admin") grantAccess();';
            const improvedCode = 'Add a check for user.active before granting access';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });
    });

    describe('truncated', () => {
        it('flags unbalanced brackets', () => {
            const existingCode = 'function parseConfig(raw) {\n  return JSON.parse(raw);\n}';
            const improvedCode =
                'function parseConfig(raw) {\n  try {\n    return JSON.parse(raw);\n  } catch {\n    return safe default pa';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('flags a tail that stops mid-token', () => {
            const existingCode = 'const x = compute();';
            const improvedCode = 'const x = compute() + fallback';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('does not flag a fix whose tail closes a block cleanly', () => {
            const existingCode = 'if (x) { doA(); }';
            const improvedCode = 'if (x) {\n  doA();\n  doB();\n}';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });
    });

    describe('usable fixes', () => {
        it('accepts a real single-line fix', () => {
            const existingCode = 'const result = data.map(x => x.value);';
            const improvedCode = 'const result = data?.map(x => x.value) ?? [];';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
            expect(isUsableFix(existingCode, improvedCode)).toBe(true);
        });

        it('accepts a real multi-line fix', () => {
            const existingCode = 'catch (e) { console.log(e); }';
            const improvedCode = 'catch (e) {\n  throw e;\n}';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('accepts code that legitimately contains a trailing string literal', () => {
            const existingCode = 'const msg = "old";';
            const improvedCode = 'const msg = "new value";';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('does not misread a fix ending in a comment as prose-only', () => {
            const existingCode = 'const x = 1;';
            const improvedCode = 'const x = 1; // fixed the off-by-one';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });
    });
});
