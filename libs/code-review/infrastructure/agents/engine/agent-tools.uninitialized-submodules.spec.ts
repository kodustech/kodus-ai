import { buildAgentTools } from './agent-tools.factory';
import {
    parseGitmodulesPaths,
    createSubmoduleProbe,
    UNINITIALIZED_SUBMODULE_MARKER,
    MISSING_DEPENDENCIES_MARKER,
} from './uninitialized-submodules';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/**
 * #1939 — the sandbox checkout never runs `git submodule update`, so a path
 * declared in `.gitmodules` exists but is empty. grep/listDir/findFile answered
 * "nothing here" and the finder published "X is undefined everywhere in the
 * repo" (critical); the verifier re-ran the same empty search and kept it.
 *
 * The contract under test: an empty answer about a declared-but-unfetched
 * submodule says WHY it is empty. A genuinely empty directory stays plain, and
 * a search that found something is never annotated.
 */

const GITMODULES = [
    '[submodule "packages/commons"]',
    '\tpath = packages/commons',
    '\turl = https://github.com/acme/commons.git',
    '[submodule "packages/brain"]',
    '\tpath = packages/brain',
    '\turl = https://github.com/acme/brain.git',
].join('\n');

/**
 * A sandbox whose checkout matches the bug: `.gitmodules` lists two submodules,
 * both directories are present and empty, and `src/` has real content.
 */
function makeSandbox(
    opts: {
        gitmodules?: string | null;
        populated?: Record<string, string>;
    } = {},
): RemoteCommands & { readCalls: string[] } {
    const { gitmodules = GITMODULES, populated = {} } = opts;
    const readCalls: string[] = [];
    const tree: Record<string, string> = {
        'src': 'src/app.ts',
        '.': 'src/app.ts\n.gitmodules',
        ...populated,
    };
    return {
        readCalls,
        read: async (p: string) => {
            readCalls.push(p);
            if (p === '.gitmodules') {
                if (gitmodules == null) {
                    throw new Error(
                        'cat: .gitmodules: No such file or directory',
                    );
                }
                return gitmodules;
            }
            throw new Error(`cat: ${p}: No such file or directory`);
        },
        // An uninitialized submodule directory EXISTS and is empty, so `find`
        // succeeds with empty stdout — the provider returns '' with no error.
        listDir: async (p: string) => tree[p] ?? '',
        grep: async () => '',
    };
}

describe('parseGitmodulesPaths', () => {
    it('reads every declared path and ignores the urls', () => {
        expect(parseGitmodulesPaths(GITMODULES)).toEqual([
            'packages/commons',
            'packages/brain',
        ]);
    });

    it('normalizes leading ./ and trailing slashes, and dedupes', () => {
        const parsed = parseGitmodulesPaths(
            '[submodule "a"]\n path = ./vendor/a/ \n[submodule "b"]\n PATH = vendor/a\n',
        );
        expect(parsed).toEqual(['vendor/a']);
    });

    it('returns nothing for a file with no path entries', () => {
        expect(parseGitmodulesPaths('')).toEqual([]);
        expect(parseGitmodulesPaths('[submodule "a"]\n url = x\n')).toEqual([]);
    });
});

describe('submodule probe', () => {
    it('reads .gitmodules once no matter how many tools ask', async () => {
        const sandbox = makeSandbox();
        const probe = createSubmoduleProbe(sandbox);
        await probe.explainEmptyResult('packages/commons');
        await probe.explainEmptyResult('packages/brain');
        await probe.explainEmptyResult('packages');
        expect(
            sandbox.readCalls.filter((p) => p === '.gitmodules'),
        ).toHaveLength(1);
    });

    it('stays silent when the submodule is actually populated', async () => {
        const sandbox = makeSandbox({
            populated: { 'packages/commons': 'packages/commons/date.ts' },
        });
        const probe = createSubmoduleProbe(sandbox);
        expect(await probe.explainEmptyResult('packages/commons')).toBeNull();
    });

    it('does not claim "uninitialized" when the listing itself failed', async () => {
        const sandbox = makeSandbox();
        sandbox.listDir = async () => {
            throw new Error('sandbox died');
        };
        const probe = createSubmoduleProbe(sandbox);
        expect(await probe.explainEmptyResult('packages/commons')).toBeNull();
    });
});

describe('tools — empty answer about an unfetched submodule explains itself', () => {
    it('listDir on the submodule itself', async () => {
        const out = await buildAgentTools(makeSandbox()).listDir.execute({
            path: 'packages/commons',
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
        expect(out).toContain('packages/commons');
    });

    it('grep on the submodule — the exact shape that produced the critical false positive', async () => {
        const out = await buildAgentTools(makeSandbox()).grep.execute({
            pattern: 'coerceToDate',
            path: 'packages/commons',
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
        // The instruction the finder and the verifier both needed.
        expect(out).toMatch(/NOT evidence/i);
    });

    it('grep with namesOnly — the branch that returns before the note', async () => {
        // `namesOnly` maps the answer to a list of file names. An EMPTY
        // answer maps to an empty answer, so the marker has to be applied
        // before that mapping or this path silently reproduces the #1939
        // false positive while every other grep shape is covered.
        const out = await buildAgentTools(makeSandbox()).grep.execute({
            pattern: 'coerceToDate',
            path: 'packages/commons',
            namesOnly: true,
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
        expect(out).toMatch(/NOT evidence/i);
    });

    it('grep with namesOnly still lists file names when there ARE matches', async () => {
        const sandbox = makeSandbox();
        sandbox.grep = jest.fn(
            async () => 'packages/commons/date.ts:3:coerceToDate\n',
        ) as any;
        const out = await buildAgentTools(sandbox).grep.execute({
            pattern: 'coerceToDate',
            path: 'packages/commons',
            namesOnly: true,
        });
        expect(out).toBe('packages/commons/date.ts');
        expect(out).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('grep on the PARENT directory — trace 6a5dbd2d used path="packages"', async () => {
        const out = await buildAgentTools(makeSandbox()).grep.execute({
            pattern: 'successPreSerialized',
            path: 'packages',
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
        expect(out).toContain('packages/commons');
        expect(out).toContain('packages/brain');
    });

    it('grep at the repo root', async () => {
        const out = await buildAgentTools(makeSandbox()).grep.execute({
            pattern: 'coerceToDate',
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('findFile on the submodule — trace 05b83fbe used findFile("date*")', async () => {
        const out = await buildAgentTools(makeSandbox()).findFile.execute({
            pattern: 'date*',
            path: 'packages/commons',
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('a path INSIDE the submodule is covered too', async () => {
        const out = await buildAgentTools(makeSandbox()).listDir.execute({
            path: 'packages/commons/utils/transforms',
        });
        expect(out).toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('keeps the original tool output alongside the note', async () => {
        const out = await buildAgentTools(makeSandbox()).findFile.execute({
            pattern: 'date*',
            path: 'packages/commons',
        });
        expect(out).toContain('No files matching "date*"');
    });
});

/**
 * The other half of trace 6a5dbd2d: after the empty submodule search the model
 * fell back to `node_modules/@<vendor>/<pkg>` and got "No such file or
 * directory", then published "response.successPreSerialized is undefined
 * everywhere in the repo" as critical. The sandbox has no install step, so
 * node_modules is absent in every review.
 */
describe('tools — a node_modules lookup says the dependencies were never installed', () => {
    /** No install step ran, so every node_modules path is simply missing. */
    const noInstall = () => {
        const sandbox = makeSandbox({ gitmodules: null });
        sandbox.grep = async (_p: string, path: string) => {
            if (path.includes('node_modules')) {
                throw new Error(
                    `${path}: No such file or directory (os error 2)`,
                );
            }
            return '';
        };
        return sandbox;
    };

    it('grep — the exact shape from the trace', async () => {
        const out = await buildAgentTools(noInstall()).grep.execute({
            pattern: 'successPreSerialized',
            path: 'node_modules/@acme/commons',
        });
        expect(out).toContain(MISSING_DEPENDENCIES_MARKER);
        expect(out).toMatch(/NOT evidence/i);
    });

    /**
     * The shape the E2B provider actually produces. `remoteCommands.grep`
     * RETURNS `Error: <stderr>` when ripgrep exits >= 2 — it does not throw
     * (`e2b-sandbox.service.ts`) — so the returning path needs its own
     * coverage. The throwing fixture above only exercises the catch.
     */
    const noInstallReturns = () => {
        const sandbox = makeSandbox({ gitmodules: null });
        sandbox.grep = (async (_p: string, path: string) =>
            path.includes('node_modules')
                ? `Error: ${path}: No such file or directory (os error 2)`
                : '') as any;
        return sandbox;
    };

    it('grep — the provider RETURNS the error string instead of throwing', async () => {
        const out = await buildAgentTools(noInstallReturns()).grep.execute({
            pattern: 'successPreSerialized',
            path: 'node_modules/@acme/commons',
        });
        expect(out).toContain(MISSING_DEPENDENCIES_MARKER);
    });

    it('grep with namesOnly on a missing node_modules keeps the message AND the marker', async () => {
        // Without the shared predicate this maps `Error: <path>: No such
        // file...` through `split(':')[0]` and hands the agent the bare
        // literal `Error` — no marker, no message.
        const out = await buildAgentTools(noInstallReturns()).grep.execute({
            pattern: 'successPreSerialized',
            path: 'node_modules/@acme/commons',
            namesOnly: true,
        });
        expect(out).not.toBe('Error');
        expect(out).toContain('No such file or directory');
        expect(out).toContain(MISSING_DEPENDENCIES_MARKER);
    });

    it.each([
        ['Error: regex parse error: unclosed group'],
        ['Error: Permission denied (os error 13)'],
    ])('namesOnly keeps a provider error intact: %s', async (message) => {
        // Not a #1939 case — there is no absence to explain — but the same
        // mapping. `split(":")[0]` would hand the agent the literal `Error`
        // and throw away the reason its own call failed.
        const sandbox = makeSandbox({ gitmodules: null });
        sandbox.grep = (async () => message) as any;
        const out = await buildAgentTools(sandbox).grep.execute({
            pattern: 'foo(?=bar)',
            path: 'src',
            namesOnly: true,
        });
        expect(out).toBe(message);
    });

    it('namesOnly still maps a file whose name starts with Error', async () => {
        const sandbox = makeSandbox({ gitmodules: null });
        sandbox.grep = (async () =>
            'src/ErrorBoundary.tsx:12:catch\n') as any;
        const out = await buildAgentTools(sandbox).grep.execute({
            pattern: 'catch',
            path: 'src',
            namesOnly: true,
        });
        expect(out).toBe('src/ErrorBoundary.tsx');
    });

    it('findFile — trace 6a5dbd2d also tried findFile("response.ts")', async () => {
        const out = await buildAgentTools(noInstall()).findFile.execute({
            pattern: 'response.ts',
            path: 'node_modules/@acme/commons',
        });
        expect(out).toContain(MISSING_DEPENDENCIES_MARKER);
    });

    it('listDir on a node_modules path', async () => {
        const out = await buildAgentTools(noInstall()).listDir.execute({
            path: 'node_modules/@acme/commons',
        });
        expect(out).toContain(MISSING_DEPENDENCIES_MARKER);
    });

    it('names the nearest install root in a monorepo, not the repo root', async () => {
        const out = await buildAgentTools(noInstall()).listDir.execute({
            path: 'apps/web/node_modules/react',
        });
        expect(out).toContain('apps/web/node_modules');
    });

    it('stays silent when node_modules IS present', async () => {
        const sandbox = makeSandbox({
            gitmodules: null,
            populated: { node_modules: 'node_modules/react/index.js' },
        });
        const out = await buildAgentTools(sandbox).listDir.execute({
            path: 'node_modules/react',
        });
        expect(out).not.toContain(MISSING_DEPENDENCIES_MARKER);
    });

    it('never confuses the two markers', async () => {
        const out = await buildAgentTools(noInstall()).listDir.execute({
            path: 'node_modules/@acme/commons',
        });
        expect(out).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('a missing path OUTSIDE node_modules is still a plain absence', async () => {
        const sandbox = makeSandbox({ gitmodules: null });
        const out = await buildAgentTools(sandbox).listDir.execute({
            path: 'src/typo',
        });
        expect(out).not.toContain(MISSING_DEPENDENCIES_MARKER);
        expect(out).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });
});

describe('tools — the note fires ONLY for unfetched submodules', () => {
    it('a genuinely empty directory in a repo with no .gitmodules stays plain', async () => {
        const tools = buildAgentTools(makeSandbox({ gitmodules: null }));
        expect(await tools.listDir.execute({ path: 'empty-dir' })).toBe('');
        expect(
            await tools.grep.execute({ pattern: 'nope', path: 'empty-dir' }),
        ).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('a genuinely empty directory in a repo that DOES declare submodules stays plain', async () => {
        const out = await buildAgentTools(makeSandbox()).listDir.execute({
            path: 'docs/generated',
        });
        expect(out).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
    });

    it('a search that found something is never annotated', async () => {
        const sandbox = makeSandbox();
        sandbox.grep = async () => 'packages/commons/date.ts:1:coerceToDate';
        const out = await buildAgentTools(sandbox).grep.execute({
            pattern: 'coerceToDate',
            path: 'packages',
        });
        expect(out).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
        expect(out).toContain('coerceToDate');
    });

    it('a populated submodule is never annotated', async () => {
        const sandbox = makeSandbox({
            populated: {
                'packages/commons': 'packages/commons/date.ts',
                'packages/brain': 'packages/brain/index.ts',
            },
        });
        const out = await buildAgentTools(sandbox).grep.execute({
            pattern: 'somethingAbsent',
            path: 'packages/commons',
        });
        // The grep fallback (no `exec` in this sandbox) answers with a bare
        // empty string — the point is that it comes back UNANNOTATED.
        expect(out).toBe('');
    });

    it('a repo with no .gitmodules pays exactly one failed read for the whole review', async () => {
        const sandbox = makeSandbox({ gitmodules: null });
        const tools = buildAgentTools(sandbox);
        await tools.listDir.execute({ path: 'a' });
        await tools.grep.execute({ pattern: 'x', path: 'b' });
        await tools.findFile.execute({ pattern: 'y', path: 'c' });
        expect(
            sandbox.readCalls.filter((p) => p === '.gitmodules'),
        ).toHaveLength(1);
    });
});
