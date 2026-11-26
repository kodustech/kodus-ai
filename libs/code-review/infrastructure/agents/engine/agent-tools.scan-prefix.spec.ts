import { MAX_TOOL_SCAN_CHARS } from '@libs/common/utils/tool-output/scan-prefix';
import { withoutSecretFileLines } from '@libs/code-review/infrastructure/agents/engine/secret-files';

import {
    buildAgentTools,
    MAX_GREP_GROUPS,
    PARTIAL_GREP_NO_VISIBLE_MATCH,
    PARTIAL_GREP_STOPPED_EMPTY,
    PARTIAL_NAMES_NOTE,
} from './agent-tools.factory';

// The real filter, recorded: the test checks how much of an answer it reads.
jest.mock('@libs/code-review/infrastructure/agents/engine/secret-files', () => {
    const actual = jest.requireActual(
        '@libs/code-review/infrastructure/agents/engine/secret-files',
    );
    return {
        ...actual,
        withoutSecretFileLines: jest.fn(actual.withoutSecretFileLines),
    };
});

/**
 * rg -n -C 2 over a big repository can print hundreds of MB. The grep tool
 * keeps 40 match groups, so the secret filter, which runs on the worker's
 * main thread, must only ever read a bounded head of that output.
 */
describe('agent tools — grep reads a bounded head of a huge rg answer', () => {
    // 60 MB of rg context groups; a secret file's match sits first.
    const group = (i: number) =>
        [
            `src/f${i}.ts-1-import x from 'y';`,
            `src/f${i}.ts:2:const value = compute(${i});`,
            `src/f${i}.ts-3-export default value;`,
        ].join('\n');
    const groups = Math.ceil(60_000_000 / (group(1).length + 4));
    const stdout = [
        '.env:1:API_TOKEN=FAKE_VALUE_7f3a',
        ...Array.from({ length: groups }, (_, i) => group(i)),
    ].join('\n--\n');

    const filter = withoutSecretFileLines as jest.Mock;

    beforeEach(() => filter.mockClear());

    const HIDDEN_NOTE =
        " more matches hidden — narrow with a more specific regex, glob='*.ts', path=<subdir>, or excludeTests=true)";
    /** What the tool answers for what the filter kept: 40 groups and a floor. */
    const expectedAnswer = () => {
        // The first filter call reads the search head; later ones see the answer.
        const kept = (filter.mock.results[0].value as string)
            .trim()
            .split('\n--\n');
        return (
            kept.slice(0, MAX_GREP_GROUPS).join('\n--\n') +
            `\n... (${kept.length - MAX_GREP_GROUPS}+${HIDDEN_NOTE}`
        );
    };

    it('filters only the head and still returns the capped groups', async () => {
        const rc: any = {
            exec: jest.fn().mockResolvedValue({ stdout, exitCode: 0 }),
            grep: jest.fn().mockResolvedValue(''),
        };

        const out = (await buildAgentTools(rc).grep.execute({
            pattern: 'compute',
        })) as string;

        const read = filter.mock.calls.map(([t]) => (t as string).length);
        expect(read.length).toBeGreaterThan(0);
        expect(Math.max(...read)).toBeLessThanOrEqual(MAX_TOOL_SCAN_CHARS);
        expect(out).not.toContain('FAKE_VALUE_7f3a');
        // The count is a floor ("N+"): the rest of the answer was never read.
        expect(out).toBe(expectedAnswer());
    });

    // The sandbox stops rg at its output cap and reports the kill's exit
    // code. Read as an error, it used to send the search to a second, uncapped
    // rg run through remoteCommands.grep.
    // The kill's exit code is not the command's: SIGKILL (137) or none (-1).
    it.each([137, -1])('reads a capped rg run (exit %i) as partial output, without a second search', async (exitCode) => {
        const rc: any = {
            exec: jest.fn().mockResolvedValue({
                stdout: stdout.slice(0, 2_000_000),
                stderr: '',
                exitCode,
                truncated: true,
            }),
            grep: jest.fn().mockResolvedValue(''),
        };

        const out = (await buildAgentTools(rc).grep.execute({
            pattern: 'compute',
        })) as string;

        expect(rc.grep).not.toHaveBeenCalled();
        expect(out).toBe(expectedAnswer());
    });

    it('does not answer "no matches" when the part read held only secret files', async () => {
        const secrets = Array.from(
            { length: 80_000 }, // ~1.8M characters, past the 1M read
            (_, i) => `.env:${i}:TOKEN_${i}=x`,
        ).join('\n');
        const rc: any = {
            exec: jest.fn().mockResolvedValue({
                stdout: `${secrets}\nsrc/a.ts:1:compute()`,
                stderr: '',
                exitCode: 0,
            }),
            grep: jest.fn().mockResolvedValue(''),
        };

        const out = await buildAgentTools(rc).grep.execute({ pattern: 'TOKEN' });

        expect(out).toBe(PARTIAL_GREP_NO_VISIBLE_MATCH);
    });

    it('does not blame secret files when the cut came from stderr alone', async () => {
        const rc: any = {
            exec: jest.fn().mockResolvedValue({
                stdout: '',
                stderr: 'rg: permission denied\n'.repeat(100_000),
                exitCode: -1,
                truncated: true,
            }),
            grep: jest.fn().mockResolvedValue(''),
        };

        const out = await buildAgentTools(rc).grep.execute({ pattern: 'x' });

        expect(out).toBe(PARTIAL_GREP_STOPPED_EMPTY);
        expect(rc.grep).not.toHaveBeenCalled();
    });

    it('says a cut file-name list may be incomplete', async () => {
        const names = Array.from({ length: 3 }, (_, i) => `src/f${i}.ts`).join('\n');
        const rc: any = {
            exec: jest.fn().mockResolvedValue({
                stdout: names,
                stderr: '',
                exitCode: -1,
                truncated: true,
            }),
            grep: jest.fn().mockResolvedValue(''),
        };

        const out = await buildAgentTools(rc).grep.execute({
            pattern: 'x',
            namesOnly: true,
        });

        expect(out).toBe(`${names}\n${PARTIAL_NAMES_NOTE}`);
    });
});
