import { buildAgentTools } from './agent-tools.factory';

/**
 * The sandbox stops a search at its output cap (exec `truncated`), and the
 * tool reads only the head of a long answer. On the linked-repository and the
 * fallback paths, a cut answer must say it is partial, never "no matches",
 * and a run stopped at the cap must not be read as a failed search.
 */
const SECRET_ONLY =
    'Matches were found, but the part of the output that was read only had matches in secret files, which are not shown. Narrow the search with a path, a glob or a more specific regex.';
const STOPPED_EMPTY =
    'The search was stopped at the output limit before it printed any match, so whether anything matches is unknown. Narrow the search with a path, a glob or a more specific regex.';
const NAMES_NOTE =
    '... (the search output was cut: more files may match — narrow with a path or glob)';

const linkedAccess: any = {
    list: () => [{ repository: 'acme/shared', preferredRef: 'main' }],
    ensureCloned: async () => ({
        ok: true,
        rootPath: '/sandbox/_linked/acme-shared',
        repository: 'acme/shared',
    }),
};

const secrets = Array.from({ length: 80_000 }, (_, i) => `.env:${i}:K${i}=x`).join('\n');

describe('agent tools — grep on a linked repository, cut answers', () => {
    const grep = (execResult: any, args: Record<string, unknown> = {}) => {
        const rc: any = {
            exec: jest.fn().mockResolvedValue(execResult),
            grep: jest.fn().mockResolvedValue(''),
        };
        const tools = buildAgentTools(
            rc, undefined, undefined, undefined, undefined, undefined, linkedAccess,
        );
        return tools.grep.execute({ pattern: 'x', repo: 'acme/shared', ...args });
    };

    it('reads a run stopped at the cap as partial, not as an error', async () => {
        expect(
            await grep(
                { stdout: 'src/a.ts:1:x()', stderr: '', exitCode: 137, truncated: true },
            ),
        ).toBe(
            '[acme/shared] src/a.ts:1:x()\n... (more matches hidden — narrow with a more specific regex)',
        );
    });

    it('still reports a real search error', async () => {
        expect(await grep({ stdout: '', stderr: 'bad regex', exitCode: 2 })).toBe(
            'Error searching linked repo acme/shared for "x"',
        );
    });

    it('answers "no matches" only for a complete empty answer', async () => {
        expect(await grep({ stdout: '', stderr: '', exitCode: 1 })).toBe(
            'No matches found in linked repo acme/shared.',
        );
    });

    it('does not answer "no matches" when the read part held only secret files', async () => {
        expect(await grep({ stdout: secrets, stderr: '', exitCode: 0 })).toBe(SECRET_ONLY);
    });

    it('says the result is unknown when only stderr filled the cap', async () => {
        expect(
            await grep({ stdout: '', stderr: 'e\n'.repeat(10), exitCode: -1, truncated: true }),
        ).toBe(STOPPED_EMPTY);
    });

    it('says a cut file-name list may be incomplete', async () => {
        expect(
            await grep(
                { stdout: 'src/a.ts\nsrc/b.ts', stderr: '', exitCode: -1, truncated: true },
                { namesOnly: true },
            ),
        ).toBe(`[acme/shared] src/a.ts\n[acme/shared] src/b.ts\n${NAMES_NOTE}`);
    });

    it('counts hidden groups as a floor when the answer was cut', async () => {
        const groups = Array.from({ length: 45 }, (_, i) => `src/f${i}.ts:1:x()`).join('\n--\n');
        const out = await grep({ stdout: groups, stderr: '', exitCode: -1, truncated: true });
        expect(out).toBe(
            Array.from({ length: 40 }, (_, i) => `[acme/shared] src/f${i}.ts:1:x()`).join('\n--\n') +
                '\n... (5+ more matches hidden — narrow with a more specific regex)',
        );
    });
});

describe('agent tools — grep fallback, cut answers', () => {
    // rg fails for real (exit 2, not truncated): the tool falls back to grep.
    const fallback = (grepResult: string, args: Record<string, unknown> = {}) => {
        const rc: any = {
            exec: jest.fn().mockResolvedValue({ stdout: '', stderr: 'rg: error', exitCode: 2 }),
            grep: jest.fn().mockResolvedValue(grepResult),
        };
        return buildAgentTools(rc).grep.execute({ pattern: 'x', ...args });
    };
    const long = Array.from({ length: 70_000 }, (_, i) => `src/f${i}.ts:1:const v = ${i};`).join('\n');

    it('does not answer with an empty list when the read part held only secret files', async () => {
        expect(await fallback(secrets)).toBe(SECRET_ONLY);
    });

    it('says a cut file-name list may be incomplete', async () => {
        const out = (await fallback(long, { namesOnly: true })) as string;
        const names = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`).join('\n');
        expect(out).toBe(`${names}\n${NAMES_NOTE}`);
    });

    it('lists a complete short answer without a note', async () => {
        expect(await fallback('src/a.ts:1:x()', { namesOnly: true })).toBe('src/a.ts');
    });

    it('marks the hidden-line count of a cut answer as a floor', async () => {
        const out = (await fallback(long)) as string;
        expect(out.split('\n').slice(0, 50).join('\n')).toBe(long.split('\n').slice(0, 50).join('\n'));
        // The tool reads the first 1,000,000 characters, cut at a line end.
        const head = long.slice(0, 1_000_000);
        const read = head.slice(0, head.lastIndexOf('\n')).split('\n').length;
        expect(out.split('\n')[50]).toBe(
            `... (${read - 50}+ more matches hidden — narrow with a more specific regex, glob='*.ts', path=<subdir>, or excludeTests=true)`,
        );
    });
});
