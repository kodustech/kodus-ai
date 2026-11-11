import {
    FUZZER_FAILURE,
    GAP_AGENTS,
    buildFindReadersTool,
    buildRunSnippetTool,
    gapAgentMaxSteps,
    sandboxCanRun,
} from './gap-agents';
import { extractFindingsWithRecovery } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { buildHeavyLensPasses, runHeavyLensPasses } from './heavy-lens-passes';

jest.mock('@libs/code-review/infrastructure/agents/core/finder.agent', () => ({
    ...jest.requireActual('@libs/code-review/infrastructure/agents/core/finder.agent'),
    extractFindingsWithRecovery: jest.fn(),
}));

const remote = (exec: (cmd: string) => { stdout: string; stderr?: string; exitCode?: number }) => ({
    grep: async () => '',
    read: async () => '',
    listDir: async () => '',
    exec: async (cmd: string) => ({ stderr: '', exitCode: 0, ...exec(cmd) }),
});

describe('gap agents (exp/finder-gap-tools)', () => {
    it('budgets 12 steps, half a step per file above 8, at most 100', () => {
        expect([gapAgentMaxSteps(3), gapAgentMaxSteps(8), gapAgentMaxSteps(20), gapAgentMaxSteps(400)]).toEqual([12, 12, 18, 100]);
    });

    it('findReaders groups uses by file, readers first, changed files last', async () => {
        const tool = buildFindReadersTool(
            remote(() => ({
                stdout: ['./src/stage.ts:88:  status = "failed"', './src/cron.ts:475:  where status in (x)', './src/cron.ts:480:  if (status === y)'].join('\n'),
            })),
            new Set(['src/stage.ts']),
        );
        const out = (await tool.execute({ term: 'status' }, {} as never)).output as string;
        expect(out.indexOf('src/cron.ts')).toBeLessThan(out.indexOf('src/stage.ts'));
        expect(out).toMatch(/src\/stage\.ts \[changed in this PR\] \(0 read, 1 write\)/);
        expect(out).toMatch(/src\/cron\.ts \(2 read, 0 write\)/);
    });

    it('runSnippet writes the program through base64 and reports the exit code', async () => {
        let seen = '';
        const tool = buildRunSnippetTool(
            remote((cmd) => {
                seen = cmd;
                return { stdout: 'True\n__EXIT=0' };
            }),
        );
        const out = (await tool.execute({ language: 'python', code: "print('a' in 'abc')" }, {} as never)).output as string;
        expect(seen).toContain(Buffer.from("print('a' in 'abc')").toString('base64'));
        expect(seen).toContain('timeout 30 python3');
        expect(seen).toContain('PYTHONPATH=/opt/kodus-fuzz/py');
        expect(out).toMatch(/^exit code 0\nTrue/);
        expect((await tool.execute({ language: 'cobol', code: 'x' }, {} as never)).isError).toBe(true);
    });

    it('knows a sandbox that can run a program from one that cannot', async () => {
        expect(await sandboxCanRun(remote(() => ({ stdout: '42\n' })))).toBe(true);
        expect(await sandboxCanRun(remote(() => ({ stdout: 'Program "python3" is not allowed' })))).toBe(false);
        expect(await sandboxCanRun(undefined)).toBe(false);
    });

    it('adds the agents to the heavy passes only with a sandbox, the code-execution one only where it can run', () => {
        const env = {
            input: { changedFiles: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }], allowedLabels: ['bug', 'security', 'performance'] },
            claudeWording: false,
            isSelfContained: false,
            modelId: 'm',
            tools: { get: () => undefined, list: () => [] },
        } as never as Parameters<typeof buildHeavyLensPasses>[0];
        const labels = (extra: object) => buildHeavyLensPasses({ ...env, ...extra }).map((p) => p.label);
        const r = remote(() => ({ stdout: '' }));
        expect(labels({}).filter((l) => GAP_AGENTS.some((a) => l === `lens-${a.id}`))).toEqual([]);
        expect(labels({ remoteCommands: r })).toEqual(expect.arrayContaining(['lens-who-reads', 'lens-siblings']));
        expect(labels({ remoteCommands: r })).not.toContain('lens-code-exec');
        expect(labels({ remoteCommands: r })).not.toContain('lens-fuzz');
        expect(labels({ remoteCommands: r, sandboxCanRun: true })).toEqual(expect.arrayContaining(['lens-code-exec', 'lens-fuzz']));
        expect(labels({ remoteCommands: r, sandboxCanRun: true })).toHaveLength(14);
        expect(labels({ remoteCommands: r })).toContain('lens-intent-risks');
        expect(labels({})).not.toContain('lens-intent-risks');
    });

    it('tells a failing fuzzer run from any other output', () => {
        expect(FUZZER_FAILURE.test('Error: Property failed after 3 tests\n{ seed: 1, counterexample: [""] }')).toBe(true);
        expect(FUZZER_FAILURE.test('Falsifying example: t(s="")')).toBe(true);
        expect(FUZZER_FAILURE.test('#2: failed on input 7343133144738243405')).toBe(true);
        expect(FUZZER_FAILURE.test('Property [Main:small] failed with sample {0=1000}')).toBe(true);
        expect(FUZZER_FAILURE.test("main.rb:3: 0 successful tests, failed on: (RuntimeError)")).toBe(true);
        expect(FUZZER_FAILURE.test("Error: Cannot find module 'zod'")).toBe(false);
    });

    it('discards the findings of a pass whose run they need did not happen', async () => {
        const finding = { relevantFile: 'a.ts', relevantLinesStart: 1, relevantLinesEnd: 1, label: 'bug', suggestionContent: 'x' };
        const pass = (keeps: boolean) => ({ label: 'lens-fuzz', findingLabel: 'bug', prompt: 'p', spec: {}, keepsFindings: () => keeps }) as never;
        const params = {
            runner: { run: async () => ({ steps: [], usage: {} }) },
            recoverProse: undefined,
        } as never;
        (extractFindingsWithRecovery as jest.Mock).mockResolvedValue({ suggestions: [finding] });
        expect((await runHeavyLensPasses([pass(false)], params, {} as never)).suggestions).toEqual([]);
        expect((await runHeavyLensPasses([pass(true)], params, {} as never)).suggestions).toHaveLength(1);
    });

    it('runs the intent-risks check only on the risks its plan listed', async () => {
        const finding = { relevantFile: 'a.ts', relevantLinesStart: 1, relevantLinesEnd: 1, label: 'bug', suggestionContent: 'x' };
        (extractFindingsWithRecovery as jest.Mock).mockResolvedValue({ suggestions: [finding] });
        const run = jest.fn(async () => ({ steps: [], usage: {}, artifacts: [] }));
        const pass = (prompt?: string) =>
            ({ label: 'lens-intent-risks', findingLabel: 'bug', prompt: '', spec: {}, prepare: async () => ({ prompt, state: { steps: [], usage: {}, artifacts: [] } }) }) as never;
        const params = { runner: { run }, recoverProse: undefined } as never;
        expect((await runHeavyLensPasses([pass(undefined)], params, {} as never)).suggestions).toEqual([]);
        expect(run).not.toHaveBeenCalled();
        expect((await runHeavyLensPasses([pass('CHECK THESE')], params, {} as never)).suggestions).toHaveLength(1);
        expect((run.mock.calls[0] as any[])[1].prompt).toBe('CHECK THESE');
    });
});
