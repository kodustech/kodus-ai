import type { ToolContext } from '../../domain/contracts/tool.contract';
import type {
    CommandResult,
    CommandRunner,
} from '../../domain/contracts/command-runner.contract';
import type { Verdict } from '../../domain/contracts/verifier.contract';
import { ExecutableVerifier, type ExecutableCheck } from './executable-verifier';

const ctx = { runId: 'r1' } as ToolContext;

/** A candidate finding: a claimed defect anchored to a file+line. */
interface Finding {
    file: string | null;
    line: number;
    claim: string;
}

/** A CommandRunner that returns a scripted result and counts runs. */
function fakeRunner(
    result: CommandResult | (() => Promise<CommandResult>),
): CommandRunner & { calls: number; commands: string[]; lastSignal?: AbortSignal } {
    const state = {
        calls: 0,
        commands: [] as string[],
        lastSignal: undefined as AbortSignal | undefined,
        async run(command: string, opts?: { signal?: AbortSignal }) {
            state.calls++;
            state.commands.push(command);
            state.lastSignal = opts?.signal;
            return typeof result === 'function' ? result() : result;
        },
    };
    return state;
}

const okResult: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
const errResult: CommandResult = {
    exitCode: 2,
    stdout: "src/x.ts(12,5): error TS2322: Type 'string' is not assignable to 'number'.",
    stderr: '',
};

/** A tsc-style check: run `tsc <file>`; keep the finding only if tsc flags it. */
const tscCheck: ExecutableCheck<Finding> = {
    command: (f) => (f.file ? `tsc --noEmit ${f.file}` : null),
    cacheKey: (f) => f.file, // every finding in a file shares one tsc run
    interpret: (f, r): Verdict => {
        const flagsLine = r.stdout.includes(`${f.file}(${f.line}`);
        return flagsLine
            ? {
                  keep: true,
                  confidence: 'high',
                  rationale: 'tsc flags the changed line — confirmed.',
                  dimensions: [{ name: 'tsc', pass: true, note: 'flags line' }],
              }
            : {
                  keep: false,
                  confidence: 'high',
                  rationale: 'tsc does not flag this line — refuted.',
                  dimensions: [{ name: 'tsc', pass: false }],
              };
    },
};

describe('ExecutableVerifier', () => {
    it('keeps (fail open, low confidence) when no check applies', async () => {
        const runner = fakeRunner(okResult);
        const v = new ExecutableVerifier(runner, tscCheck);

        const verdict = await v.verify({ file: null, line: 0, claim: 'x' }, ctx);

        expect(verdict.keep).toBe(true);
        expect(verdict.confidence).toBe('low');
        expect(runner.calls).toBe(0); // no command run when command() is null
    });

    it('refutes (keep:false) when the objective signal disagrees', async () => {
        const runner = fakeRunner(okResult); // tsc clean → no error at the line
        const v = new ExecutableVerifier(runner, tscCheck);

        const verdict = await v.verify({ file: 'src/x.ts', line: 12, claim: 'type bug' }, ctx);

        expect(verdict.keep).toBe(false);
        expect(verdict.dimensions).toEqual([{ name: 'tsc', pass: false }]);
        expect(runner.commands).toEqual(['tsc --noEmit src/x.ts']);
    });

    it('confirms (keep:true) with an objective dimension when the signal agrees', async () => {
        const runner = fakeRunner(errResult); // tsc flags src/x.ts(12,...)
        const v = new ExecutableVerifier(runner, tscCheck);

        const verdict = await v.verify({ file: 'src/x.ts', line: 12, claim: 'type bug' }, ctx);

        expect(verdict.keep).toBe(true);
        expect(verdict.confidence).toBe('high');
        expect(verdict.dimensions).toEqual([{ name: 'tsc', pass: true, note: 'flags line' }]);
    });

    it('fails open when the runner cannot launch the command', async () => {
        const runner = fakeRunner(async () => {
            throw new Error('sandbox gone');
        });
        const v = new ExecutableVerifier(runner, tscCheck);

        const verdict = await v.verify({ file: 'src/x.ts', line: 12, claim: 'x' }, ctx);

        expect(verdict.keep).toBe(true); // never silently drop on a runner error
        expect(verdict.confidence).toBe('low');
    });

    it('memoizes by cacheKey — candidates sharing a file run tsc once', async () => {
        const runner = fakeRunner(errResult);
        const v = new ExecutableVerifier(runner, tscCheck);

        const a = await v.verify({ file: 'src/x.ts', line: 12, claim: 'a' }, ctx);
        const b = await v.verify({ file: 'src/x.ts', line: 99, claim: 'b' }, ctx);

        expect(runner.calls).toBe(1); // one tsc for both findings in src/x.ts
        expect(a.keep).toBe(true); // line 12 IS flagged
        expect(b.keep).toBe(false); // line 99 is not — same run, different verdict
    });

    it('runs per-candidate when there is no cacheKey', async () => {
        const noKeyCheck: ExecutableCheck<Finding> = { ...tscCheck, cacheKey: undefined };
        const runner = fakeRunner(okResult);
        const v = new ExecutableVerifier(runner, noKeyCheck);

        await v.verify({ file: 'a.ts', line: 1, claim: 'x' }, ctx);
        await v.verify({ file: 'b.ts', line: 1, claim: 'y' }, ctx);

        expect(runner.calls).toBe(2);
    });

    it('forwards the abort signal to the runner', async () => {
        const signal = new AbortController().signal;
        const runner = fakeRunner(okResult);
        const v = new ExecutableVerifier(runner, tscCheck);

        await v.verify({ file: 'a.ts', line: 1, claim: 'x' }, { runId: 'r', signal } as ToolContext);

        expect(runner.lastSignal).toBe(signal);
    });
});
