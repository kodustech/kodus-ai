/**
 * astGrep tool — deterministic, no sandbox. The exec is mocked so the tests
 * pin the command the tool emits (argv shape, neutral config, no rewrite
 * flags) and how `--json=stream` output is parsed and capped.
 */
import {
    AST_GREP_TOOL_NAME,
    MAX_AST_GREP_MATCHES,
    buildAstGrepTool,
    type AstGrepToolDeps,
} from '@libs/code-review/infrastructure/agents/adapters/ast-grep.tool';

const ctx = { runId: 'r' } as any;
const WORK_DIR = '.kody-ast-grep-test';

function match(
    file: string,
    line: number,
    text: string,
    extra: Record<string, unknown> = {},
) {
    return JSON.stringify({
        text,
        file,
        range: {
            start: { line: line - 1, column: 4 },
            end: { line: line - 1, column: 4 + text.length },
        },
        language: 'TypeScript',
        ...extra,
    });
}

function setup(overrides: Partial<AstGrepToolDeps> = {}) {
    const exec = jest.fn(async (_command: string) => ({
        stdout: '',
        stderr: '',
        exitCode: 1,
    }));
    const writeFile = jest.fn(async (_path: string, _content: string) => {});
    const readTargetFile = jest.fn(async (_path: string) => null as any);
    const deps: AstGrepToolDeps = {
        exec,
        writeFile,
        changedFiles: ['src/orders/checkout.ts', 'src/orders/cart.ts'],
        readTargetFile,
        workDirName: WORK_DIR,
        ...overrides,
    };
    return {
        tool: buildAstGrepTool(deps),
        exec: (overrides.exec as jest.Mock) ?? exec,
        writeFile: (overrides.writeFile as jest.Mock) ?? writeFile,
        readTargetFile:
            (overrides.readTargetFile as jest.Mock) ?? readTargetFile,
    };
}

/** Undo the single-quote shell quoting the tool applies, so assertions read
 *  the argv the program receives. */
function argvOf(command: string): string[] {
    const out: string[] = [];
    const re = /'((?:[^']|'\\'')*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) out.push(m[1].replace(/'\\''/g, "'"));
    return out;
}

describe('astGrep tool', () => {
    it('is named astGrep and only offers rules when a rule path is set', () => {
        const { tool } = setup();
        expect(tool.name).toBe(AST_GREP_TOOL_NAME);
        expect(tool.inputSchema.properties).not.toHaveProperty('useRules');

        const withRules = setup({ rulesPath: 'tools/review-rules.yml' });
        expect(withRules.tool.inputSchema.properties).toHaveProperty(
            'useRules',
        );
    });

    it('runs a pattern search as quoted argv with a neutral config and no rewrite flags', async () => {
        const { tool, exec, writeFile } = setup();
        exec.mockResolvedValueOnce({
            stdout: [
                match('src/orders/checkout.ts', 12, 'console.log(total)'),
                match('src/orders/cart.ts', 3, "console.log('it''s')"),
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const r = await tool.execute(
            {
                pattern: "console.log('$A')",
                language: 'typescript',
                paths: ['src/orders'],
            },
            ctx,
        );

        expect(writeFile).toHaveBeenCalledWith(
            `${WORK_DIR}/sgconfig.yml`,
            'ruleDirs: []\n',
        );
        const command = exec.mock.calls[0][0];
        expect(argvOf(command)).toEqual([
            'ast-grep',
            'run',
            `--config=${WORK_DIR}/sgconfig.yml`,
            "--pattern=console.log('$A')",
            '--lang=typescript',
            '--json=stream',
            '--',
            'src/orders',
        ]);
        expect(command).not.toMatch(/(^|\s)'?-U'?(\s|$)|--update-all|--follow/);

        expect(r.isError).toBeFalsy();
        expect(r.output).toContain('2 matches');
        expect(r.output).toContain('src/orders/checkout.ts:12:5');
        expect(r.output).toContain('console.log(total)');
        expect(r.meta).toMatchObject({ mode: 'pattern', matches: 2 });
    });

    it('searches the whole repository when no path is given', async () => {
        const { tool, exec } = setup();
        await tool.execute({ pattern: 'eval($X)', language: 'ts' }, ctx);
        expect(argvOf(exec.mock.calls[0][0]).slice(-2)).toEqual(['--', '.']);
    });

    it('writes the neutral config once per run', async () => {
        const { tool, writeFile } = setup();
        await tool.execute({ pattern: 'a', language: 'ts' }, ctx);
        await tool.execute({ pattern: 'b', language: 'ts' }, ctx);
        expect(writeFile).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ pattern: 'x', language: 'ts', paths: ['../outside'] }, 'path'],
        [{ pattern: 'x', language: 'ts', paths: ['/etc/passwd'] }, 'path'],
        [{ pattern: 'x', language: 'ts', paths: ['-U'] }, 'path'],
        [{ pattern: 'x', language: '-U' }, 'language'],
        [{ pattern: 'x', language: 'ts --update-all' }, 'language'],
        [{ language: 'ts' }, 'pattern'],
        [{ pattern: 'x' }, 'language'],
    ])(
        'refuses invalid input %j without running anything',
        async (input, word) => {
            const { tool, exec } = setup();
            const r = await tool.execute(input as any, ctx);
            expect(r.isError).toBe(true);
            expect(r.output.toLowerCase()).toContain(word);
            expect(exec).not.toHaveBeenCalled();
        },
    );

    it('caps the number of matches it returns', async () => {
        const { tool, exec } = setup();
        const lines = Array.from({ length: MAX_AST_GREP_MATCHES + 7 }, (_, i) =>
            match('src/orders/checkout.ts', i + 1, `call${i}()`),
        );
        exec.mockResolvedValueOnce({
            stdout: lines.join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const r = await tool.execute({ pattern: '$F()', language: 'ts' }, ctx);
        expect(r.output).toContain(`${MAX_AST_GREP_MATCHES + 7} matches`);
        expect(r.output).toContain('7 more not shown');
        expect(r.output).not.toContain(`call${MAX_AST_GREP_MATCHES}()`);
    });

    it('keeps the matches it can parse when the stream was cut mid-line', async () => {
        const { tool, exec } = setup();
        exec.mockResolvedValueOnce({
            stdout:
                match('src/orders/cart.ts', 4, 'eval(code)') +
                '\n{"text":"eval(',
            stderr: '',
            exitCode: 0,
        });
        const r = await tool.execute(
            { pattern: 'eval($A)', language: 'ts' },
            ctx,
        );
        expect(r.isError).toBeFalsy();
        expect(r.output).toContain('1 match');
        expect(r.output).toContain('src/orders/cart.ts:4:5');
    });

    it('reports no matches as a plain answer, not an error', async () => {
        const { tool } = setup();
        const r = await tool.execute({ pattern: 'zzz()', language: 'ts' }, ctx);
        expect(r.isError).toBeFalsy();
        expect(r.output).toMatch(/no matches/i);
    });

    it('surfaces an ast-grep failure as an error result', async () => {
        const { tool, exec } = setup();
        exec.mockResolvedValueOnce({
            stdout: '',
            stderr: "error: invalid value 'cobol' for '--lang <LANG>'",
            exitCode: 2,
        });
        const r = await tool.execute({ pattern: 'x', language: 'cobol' }, ctx);
        expect(r.isError).toBe(true);
        expect(r.output).toContain('invalid value');
    });

    it('returns a thrown exec as an error result instead of throwing', async () => {
        const { tool, exec } = setup();
        exec.mockRejectedValueOnce(new Error('sandbox gone'));
        const r = await tool.execute({ pattern: 'x', language: 'ts' }, ctx);
        expect(r.isError).toBe(true);
        expect(r.output).toContain('sandbox gone');
    });

    describe('rules from the target branch', () => {
        const RULES = [
            'id: no-raw-sql',
            'language: TypeScript',
            'message: Use the query builder',
            'rule:',
            '  pattern: db.raw($Q)',
        ].join('\n');

        it('writes the rules saved on the agent and never reads the branch for them', async () => {
            const readTargetFile = jest.fn(async () => 'from the branch');
            const { tool, exec, writeFile } = setup({
                rules: RULES,
                readTargetFile,
            });
            exec.mockResolvedValueOnce({
                stdout: match('src/orders/cart.ts', 9, 'db.raw(q)', {
                    ruleId: 'no-raw-sql',
                }),
                stderr: '',
                exitCode: 0,
            });

            expect(tool.inputSchema.properties).toHaveProperty('useRules');
            const r = await tool.execute({ useRules: true }, ctx);

            expect(readTargetFile).not.toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalledWith(
                `${WORK_DIR}/rules.yml`,
                RULES,
            );
            expect(r.output).toContain('[no-raw-sql]');
        });

        it('reads the rule file from the target branch and scans only the changed files', async () => {
            const readTargetFile = jest.fn(async () => RULES);
            const { tool, exec, writeFile } = setup({
                rulesPath: 'tools/review-rules.yml',
                readTargetFile,
            });
            exec.mockResolvedValueOnce({
                stdout: match('src/orders/cart.ts', 9, 'db.raw(q)', {
                    ruleId: 'no-raw-sql',
                    message: 'Use the query builder',
                }),
                stderr: '',
                exitCode: 0,
            });

            const r = await tool.execute({ useRules: true }, ctx);

            expect(readTargetFile).toHaveBeenCalledWith(
                'tools/review-rules.yml',
            );
            expect(writeFile).toHaveBeenCalledWith(
                `${WORK_DIR}/rules.yml`,
                RULES,
            );
            expect(argvOf(exec.mock.calls[0][0])).toEqual([
                'ast-grep',
                'scan',
                `--config=${WORK_DIR}/sgconfig.yml`,
                `--rule=${WORK_DIR}/rules.yml`,
                '--json=stream',
                '--',
                'src/orders/checkout.ts',
                'src/orders/cart.ts',
            ]);
            expect(r.output).toContain('[no-raw-sql] Use the query builder');
            expect(r.meta).toMatchObject({ mode: 'rules', matches: 1 });
        });

        it('never reads the rule file from the checkout (the PR head)', async () => {
            const readTargetFile = jest.fn(async () => RULES);
            const { tool, exec } = setup({
                rulesPath: 'tools/review-rules.yml',
                readTargetFile,
            });
            await tool.execute({ useRules: true }, ctx);
            const command = exec.mock.calls[0][0];
            expect(command).not.toContain("'tools/review-rules.yml'");
        });

        it('refuses rules when the agent has no rule path configured', async () => {
            const { tool, exec } = setup();
            const r = await tool.execute({ useRules: true }, ctx);
            expect(r.isError).toBe(true);
            expect(exec).not.toHaveBeenCalled();
        });

        it('returns an error when the rule file is missing on the target branch', async () => {
            const { tool, exec } = setup({
                rulesPath: 'tools/review-rules.yml',
                readTargetFile: jest.fn(async () => null),
            });
            const r = await tool.execute({ useRules: true }, ctx);
            expect(r.isError).toBe(true);
            expect(r.output).toContain('tools/review-rules.yml');
            expect(exec).not.toHaveBeenCalled();
        });

        it('refuses an oversized rule file', async () => {
            const { tool, exec } = setup({
                rulesPath: 'tools/review-rules.yml',
                readTargetFile: jest.fn(async () => 'x'.repeat(200_000)),
            });
            const r = await tool.execute({ useRules: true }, ctx);
            expect(r.isError).toBe(true);
            expect(exec).not.toHaveBeenCalled();
        });
    });
});
