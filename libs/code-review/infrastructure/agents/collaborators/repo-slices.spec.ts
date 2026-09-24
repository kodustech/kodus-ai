import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

import {
    extractContentWindow,
    extractModifiedFunctionNames,
    generateCallGraphGrep,
    readSnippetWindow,
} from './repo-slices';

/**
 * Direct coverage for the four primitives extracted out of call-graph.helper.ts
 * (T14). The helper's own spec still exercises them through its exported entry
 * points and remains the byte-identity regression guard; these tests pin each
 * primitive on its own so the Kody Rules retriever can build on them.
 */

function commands(overrides: Partial<RemoteCommands> = {}): RemoteCommands {
    return {
        grep: jest.fn(async () => ''),
        read: jest.fn(async () => ''),
        listDir: jest.fn(async () => ''),
        ...overrides,
    };
}

describe('extractContentWindow', () => {
    const content = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');

    it('returns a 1-based numbered window centered on the line', () => {
        expect(extractContentWindow(content, 4, 1)).toBe('3: c\n4: d\n5: e');
    });

    it('clamps the start to line 1', () => {
        expect(extractContentWindow(content, 1, 2)).toBe('1: a\n2: b\n3: c');
    });

    it('clamps the end to the last line', () => {
        expect(extractContentWindow(content, 7, 2)).toBe('5: e\n6: f\n7: g');
    });

    it('returns an empty string for empty content', () => {
        expect(extractContentWindow('', 3, 5)).toBe('');
    });
});

describe('readSnippetWindow', () => {
    it('reads the clamped window and returns its content', async () => {
        const read = jest.fn(async () => 'body');
        const result = await readSnippetWindow(
            commands({ read }),
            'src/a.ts',
            2,
            10,
        );

        expect(result).toBe('body');
        expect(read).toHaveBeenCalledWith('src/a.ts', 1, 12);
    });

    it('returns an empty string when the read comes back blank', async () => {
        const result = await readSnippetWindow(
            commands({ read: jest.fn(async () => '   \n  ') }),
            'src/a.ts',
            20,
            5,
        );

        expect(result).toBe('');
    });

    it('returns an empty string when the read throws', async () => {
        const result = await readSnippetWindow(
            commands({
                read: jest.fn(async () => {
                    throw new Error('sandbox gone');
                }),
            }),
            'src/a.ts',
            20,
            5,
        );

        expect(result).toBe('');
    });
});

describe('extractModifiedFunctionNames', () => {
    it('names the definitions a hunk added, with their new-file line', () => {
        const result = extractModifiedFunctionNames([
            {
                filename: 'src/a.ts',
                patch: [
                    '@@ -1,2 +1,3 @@',
                    ' const x = 1;',
                    '+export function renderInvoice(): void {}',
                    ' const y = 2;',
                ].join('\n'),
            },
        ]);

        expect(result).toEqual([
            { name: 'renderInvoice', file: 'src/a.ts', line: 2 },
        ]);
    });

    it('drops short and noise names', () => {
        const result = extractModifiedFunctionNames([
            {
                filename: 'src/a.ts',
                patch: [
                    '@@ -1,1 +1,3 @@',
                    '+function run() {}',
                    '+function process() {}',
                    '+function ab() {}',
                ].join('\n'),
            },
        ]);

        expect(result).toEqual([]);
    });

    it('dedups a repeated name, first occurrence wins', () => {
        const result = extractModifiedFunctionNames([
            {
                filename: 'src/a.ts',
                patch: [
                    '@@ -1,1 +1,2 @@',
                    '+export function renderInvoice(): void {}',
                ].join('\n'),
            },
            {
                filename: 'src/b.ts',
                patch: [
                    '@@ -1,1 +1,2 @@',
                    '+export function renderInvoice(): void {}',
                ].join('\n'),
            },
        ]);

        expect(result).toEqual([
            { name: 'renderInvoice', file: 'src/a.ts', line: 1 },
        ]);
    });

    it('returns nothing when the patch carries no hunk header', () => {
        expect(
            extractModifiedFunctionNames([
                {
                    filename: 'src/a.ts',
                    patch: 'export function renderInvoice(): void {}',
                },
            ]),
        ).toEqual([]);
    });
});

describe('generateCallGraphGrep', () => {
    const changedFiles = [
        {
            filename: 'src/a.ts',
            patch: ['@@ -1,1 +1,2 @@', '+function renderInvoice() {}'].join(
                '\n',
            ),
        },
    ];

    it('returns an empty string when the sandbox has no exec', async () => {
        expect(await generateCallGraphGrep(commands(), changedFiles)).toBe('');
    });

    it('lists the production callers of a changed function', async () => {
        const exec = jest.fn(async (command: string) => {
            if (command.startsWith('grep -nE')) {
                return {
                    stdout: '1:function renderInvoice() {}\n',
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                stdout: './src/b.ts:42:  renderInvoice(order);\n',
                stderr: '',
                exitCode: 0,
            };
        });

        const result = await generateCallGraphGrep(
            commands({ exec }),
            changedFiles,
        );

        expect(result).toBe(
            'Changed functions and their production callers:\n\n' +
                'renderInvoice (src/a.ts:1)\n' +
                '  ← src/b.ts:42  renderInvoice(order);',
        );
    });

    it('returns an empty string when the changed function has no caller', async () => {
        const exec = jest.fn(async (command: string) => {
            if (command.startsWith('grep -nE')) {
                return {
                    stdout: '1:function renderInvoice() {}\n',
                    stderr: '',
                    exitCode: 0,
                };
            }
            return { stdout: '', stderr: '', exitCode: 1 };
        });

        expect(
            await generateCallGraphGrep(commands({ exec }), changedFiles),
        ).toBe('');
    });
});
