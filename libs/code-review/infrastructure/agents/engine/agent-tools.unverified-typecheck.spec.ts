import { buildAgentTools } from './agent-tools.factory';
import {
    findProjectLevelTypeScriptErrors,
    hasLocatedTypeScriptDiagnostic,
    UNVERIFIED_TYPES_MARKER,
} from './unverified-typecheck';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/**
 * #1940 — `checkTypes` answered "No diagnostics matched <file>; omitted
 * unrelated diagnostics outside this local scope." in a sandbox where `tsc`
 * never type-checked anything: the tsconfig references a package that is not on
 * disk (no `node_modules`, submodules never fetched, #1939), so tsc exits on
 * project-level errors before building the program. The finder read the answer
 * as a clean check and published a critical finding on it (trace
 * `6a5dbd2d`).
 *
 * The contract under test: when the compiler refused to build the project, the
 * tool says the target was NOT verified instead of reporting a scoped pass. A
 * genuine clean run, diagnostics about other files, and diagnostics about the
 * target itself all keep their previous answers.
 */

const TARGET =
    'functions-splitted/store/src/requestable/api/controllers/menu.ts';
const SCOPE = 'functions-splitted/store/tsconfig.json';

/**
 * The two lines the report reproduces locally: exactly what tsc prints (exit
 * 2) when a `files` entry points at a file that is not there. One of them
 * names the target's own scope directory, which is why the target filter keeps
 * it.
 */
const SCOPE_MATCHING_OUTPUT = [
    `functions-splitted/__common/tsconfig.json(36,9): error TS6053: File '<root>/packages/acme-commons/src/index.ts' not found.`,
    `functions-splitted/store/tsconfig.json(25,9): error TS6053: File '<root>/packages/acme-commons/src/index.ts' not found.`,
].join('\n');

/**
 * The same failure with no line the target filter can match — the shape that
 * produced the exact `No diagnostics matched` answer quoted in the issue.
 */
const ELSEWHERE_OUTPUT = [
    `functions-splitted/__common/tsconfig.json(36,9): error TS6053: File '<root>/packages/acme-commons/src/index.ts' not found.`,
    `packages/acme-commons/tsconfig.json(4,9): error TS6053: File '<root>/packages/acme-core/src/index.ts' not found.`,
].join('\n');

/**
 * A sandbox holding one TypeScript file whose nearest tsconfig is `SCOPE`. The
 * exec mock answers the three shells `checkTypes` builds: the target scan, the
 * nearest-tsconfig lookup, and the compiler itself. It returns the real
 * executor's shape (`stdout`, `stderr`, `exitCode`) and records every command,
 * so a spec can pin the compiler invocation instead of only its output.
 */
function makeSandbox(tscOutput: string, tscExitCode = 0) {
    const commands: string[] = [];

    const remote = {
        read: async (p: string) => {
            throw new Error(`cat: ${p}: No such file or directory`);
        },
        listDir: async () => '',
        grep: async () => '',
        exec: (async (cmd: string) => {
            commands.push(cmd);
            // Order matters: the compiler command also mentions the tsconfig.
            if (cmd.includes('npx tsc')) {
                return { stdout: tscOutput, stderr: '', exitCode: tscExitCode };
            }
            if (cmd.includes('tsconfig.json')) {
                return { stdout: SCOPE, stderr: '', exitCode: 0 };
            }
            return { stdout: `${TARGET}\n`, stderr: '', exitCode: 0 };
        }) as RemoteCommands['exec'],
    } as RemoteCommands;

    return { commands, remote };
}

const runCheckTypes = (tscOutput: string, tscExitCode = 0) =>
    buildAgentTools(
        makeSandbox(tscOutput, tscExitCode).remote,
    ).checkTypes.execute({
        path: TARGET,
    });

describe('hasLocatedTypeScriptDiagnostic', () => {
    it('reads a diagnostic about a source file as a check that happened', () => {
        expect(
            hasLocatedTypeScriptDiagnostic(
                `functions-splitted/store/src/requestable/api/controllers/menu.ts(12,9): error TS2322: Type 'string' is not assignable to type 'number'.`,
            ),
        ).toBe(true);
    });

    it('does not count a project-level or unlocated report', () => {
        expect(hasLocatedTypeScriptDiagnostic(SCOPE_MATCHING_OUTPUT)).toBe(
            false,
        );
        expect(
            hasLocatedTypeScriptDiagnostic(
                `error TS5083: Cannot read file '<root>/packages/acme-commons/tsconfig.base.json'.`,
            ),
        ).toBe(false);
        expect(hasLocatedTypeScriptDiagnostic('')).toBe(false);
    });
});

describe('findProjectLevelTypeScriptErrors', () => {
    it('reads the codes that mean the program was never built', () => {
        expect(findProjectLevelTypeScriptErrors(SCOPE_MATCHING_OUTPUT)).toEqual(
            ['TS6053'],
        );
    });

    it('ignores diagnostics about source files', () => {
        expect(
            findProjectLevelTypeScriptErrors(
                `${TARGET}(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
            ),
        ).toEqual([]);
    });

    it('reports each project-level code once', () => {
        expect(
            findProjectLevelTypeScriptErrors(
                [
                    'tsconfig.json(1,1): error TS18003: No inputs were found in config file.',
                    'tsconfig.json(2,1): error TS18003: No inputs were found in config file.',
                    "error TS5083: Cannot read file 'x.json'.",
                ].join('\n'),
            ),
        ).toEqual(['TS18003', 'TS5083']);
    });

    it('counts a diagnostic located in a config file, whatever the code', () => {
        // A JSON syntax error in a tsconfig: no code list covers this family,
        // and the location is what identifies it.
        expect(
            findProjectLevelTypeScriptErrors(
                `ts8.json(1,2): error TS1005: '}' expected.`,
            ),
        ).toEqual(['TS1005']);
    });

    it('counts project codes a list would have missed', () => {
        expect(
            findProjectLevelTypeScriptErrors(
                [
                    `error TS5014: Failed to parse file 'tsconfig.json': Unexpected end of JSON input.`,
                    `error TS6054: File '/repo/notes.txt' has an unsupported extension.`,
                ].join('\n'),
            ),
        ).toEqual(['TS5014', 'TS6054']);
    });

    it('reads the pretty format tsc uses on a terminal', () => {
        expect(
            findProjectLevelTypeScriptErrors(
                [
                    `${TARGET}:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.`,
                    `tsconfig.json:1:2 - error TS1005: '}' expected.`,
                ].join('\n'),
            ),
        ).toEqual(['TS1005']);
    });

    it('ignores the explanation lines tsc prints under a diagnostic', () => {
        expect(
            findProjectLevelTypeScriptErrors(
                [
                    "error TS6053: File '/repo/x.ts' not found.",
                    '  The file is in the program because:',
                    "    Part of 'files' list in tsconfig.json",
                ].join('\n'),
            ),
        ).toEqual(['TS6053']);
    });

    it('is empty for a clean run and for empty output', () => {
        expect(findProjectLevelTypeScriptErrors('')).toEqual([]);
    });
});

describe('checkTypes — a compiler that could not check the project', () => {
    it('answers the reported shape: a project error with no line about the target', async () => {
        // This is the exact state the trace hit: tsc printed project-level
        // errors, none of them matched the target, and the answer read as a
        // scoped pass.
        const out = await runCheckTypes(ELSEWHERE_OUTPUT);

        expect(out).toContain(UNVERIFIED_TYPES_MARKER);
        expect(out).not.toContain('No diagnostics matched');
        expect(out).toMatch(/NOT a pass/i);
        // The codes are named, so the reader can tell why nothing was checked.
        expect(out).toContain('TS6053');
    });

    it('does not hand back the tsconfig line as if it were about the target', async () => {
        // `functions-splitted/store/tsconfig.json` sits in the target's own
        // scope directory, so the target filter KEEPS that line and the answer
        // was a plain scoped result. It is a config error, not a diagnostic
        // about the file under review.
        const out = await runCheckTypes(SCOPE_MATCHING_OUTPUT);

        expect(out).toContain(UNVERIFIED_TYPES_MARKER);
        expect(out).not.toContain('error TS6053: File');
    });

    it('keeps the diagnostics printed alongside a project-level error', async () => {
        // Measured with tsc 5.6.3: an unreadable `extends` (TS5083) and an
        // unknown compiler option (TS5023) are printed ALONGSIDE real source
        // diagnostics. Replacing them with a statement that nothing was checked
        // would lose a finding and tell the agent something false.
        const out = await runCheckTypes(
            [
                `error TS5083: Cannot read file 'functions-splitted/store/tsconfig.base.json'.`,
                `${TARGET}(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
            ].join('\n'),
        );

        expect(out).toContain(UNVERIFIED_TYPES_MARKER);
        expect(out).toContain('TS2322');
        expect(out).toContain(TARGET);
        expect(out).not.toContain('No diagnostics matched');
        // The kept lines come from the whole scope, not only from the target,
        // so the heading must not claim they all mention it.
        expect(out).toContain('not all of them mention');
    });

    it('still reports a clean run as clean', async () => {
        const out = await runCheckTypes('');

        expect(out).toContain('no type errors or linter diagnostics found');
        expect(out).not.toContain(UNVERIFIED_TYPES_MARKER);
    });

    it('flags a compiler that never ran: a non-zero exit with no diagnostic', async () => {
        // `npx` failing to resolve or start `tsc` prints nothing a TS-code
        // pattern can match, so the previous guard read it as a scoped pass.
        const out = await runCheckTypes('npx: not found', 127);

        expect(out).toContain(UNVERIFIED_TYPES_MARKER);
        expect(out).toMatch(/NOT a pass/i);
        expect(out).not.toContain('No diagnostics matched');
    });

    it('does not call a non-zero exit unverified when a diagnostic was found', async () => {
        const out = await runCheckTypes(
            `${TARGET}(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
            2,
        );

        expect(out).toContain('TS2322');
        expect(out).not.toContain(UNVERIFIED_TYPES_MARKER);
    });

    it('pins the compiler invocation and reads its own exit status', async () => {
        // `| head` would make the pipeline report the pager's status, so the
        // guard above could never see a failing compiler.
        const sandbox = makeSandbox(SCOPE_MATCHING_OUTPUT, 2);
        await buildAgentTools(sandbox.remote).checkTypes.execute({
            path: TARGET,
        });

        expect(sandbox.commands.find((cmd) => cmd.includes('npx tsc'))).toBe(
            `npx tsc --noEmit -p '${SCOPE}' 2>&1`,
        );
    });

    it('keeps the scoped answer when the diagnostics are about other files', async () => {
        const out = await runCheckTypes(
            `src/other/module.ts(1,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
        );

        expect(out).toContain('No diagnostics matched');
        expect(out).not.toContain(UNVERIFIED_TYPES_MARKER);
    });

    it('keeps real diagnostics about the target untouched', async () => {
        const out = await runCheckTypes(
            `${TARGET}(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
        );

        expect(out).toContain('TS2322');
        expect(out).toContain(TARGET);
        expect(out).not.toContain(UNVERIFIED_TYPES_MARKER);
    });
});
