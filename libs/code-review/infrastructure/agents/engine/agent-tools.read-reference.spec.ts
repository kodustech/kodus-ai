import { buildAgentTools, MAX_READ_LENGTH } from './agent-tools.factory';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/**
 * readReference reads the referenced repository's default branch when the
 * model gives no branch, and a failed read tells the model which repository,
 * path and ref were not found, so it can retry with a correct one.
 *
 * Before: the tool always sent `ref=main`, so a repository whose default
 * branch is `master` or `develop` answered 404 on every read, and the model
 * got a generic failure it could not act on.
 */
function makeRemote(): RemoteCommands {
    return {
        grep: async () => '',
        read: async () => '',
        listDir: async () => '',
    };
}

type FetchCall = { url: string; init: any };

function stubFetch(
    respond: (url: string) => {
        status: number;
        statusText: string;
        body?: string;
    },
): FetchCall[] {
    const calls: FetchCall[] = [];
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const r = respond(url);
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: r.statusText,
            text: async () => r.body ?? '',
        };
    });
    return calls;
}

// The review is of acme-brewery/app; acme-brewery/style-guide holds a skill
// or doc the team linked from it.
const readReference = () =>
    buildAgentTools(
        makeRemote(),
        'test-token',
        'acme-brewery/app',
        undefined,
        undefined,
        undefined,
        undefined,
        ['acme-brewery/style-guide'],
    ).readReference;

describe('readReference — branch selection and not-found answers', () => {
    const originalFetch = (global as any).fetch;
    afterEach(() => {
        (global as any).fetch = originalFetch;
    });

    it('reads the default branch when no branch is given (no hardcoded main)', async () => {
        const calls = stubFetch(() => ({
            status: 200,
            statusText: 'OK',
            body: '# Brewery style guide',
        }));

        const out = await readReference().execute({
            repo: 'acme-brewery/style-guide',
            path: 'docs/naming.md',
        });

        expect(out).toBe('# Brewery style guide');
        expect(calls).toHaveLength(1);
        // GitHub's contents API reads the repository's default branch when
        // `ref` is omitted; sending `ref=main` is what 404'd on master repos.
        expect(calls[0].url).not.toContain('ref=');
    });

    it('reads the given branch when the model passes one', async () => {
        const calls = stubFetch(() => ({
            status: 200,
            statusText: 'OK',
            body: 'ok',
        }));

        await readReference().execute({
            repo: 'acme-brewery/style-guide',
            path: 'docs/naming.md',
            branch: 'release/2.x',
        });

        expect(calls[0].url).toContain(
            `ref=${encodeURIComponent('release/2.x')}`,
        );
    });

    it('a 404 on the default branch names the repository, path and ref, and how to retry', async () => {
        stubFetch(() => ({ status: 404, statusText: 'Not Found' }));

        const out = await readReference().execute({
            repo: 'acme-brewery/style-guide',
            path: 'docs/missing.md',
        });

        expect(out).toMatch(/^Error:/);
        expect(out).toContain('acme-brewery/style-guide');
        expect(out).toContain('docs/missing.md');
        expect(out).toContain('default branch');
        expect(out).toMatch(/404/);
        // Actionable: tells the model what to change on the next call.
        expect(out).toMatch(/branch/i);
        expect(out).toMatch(/path/i);
    });

    it('a 404 on an explicit branch names that branch and suggests omitting it', async () => {
        stubFetch(() => ({ status: 404, statusText: 'Not Found' }));

        const out = await readReference().execute({
            repo: 'acme-brewery/style-guide',
            path: 'docs/naming.md',
            branch: 'main',
        });

        expect(out).toMatch(/^Error:/);
        expect(out).toContain('acme-brewery/style-guide');
        expect(out).toContain('docs/naming.md');
        expect(out).toContain('"main"');
        expect(out).toMatch(/omit the branch/i);
    });

    it('keeps the read length limit', async () => {
        stubFetch(() => ({
            status: 200,
            statusText: 'OK',
            body: 'x'.repeat(MAX_READ_LENGTH + 100),
        }));

        const out = await readReference().execute({
            repo: 'acme-brewery/style-guide',
            path: 'docs/long.md',
        });

        expect(out.startsWith('x'.repeat(MAX_READ_LENGTH))).toBe(true);
        expect(out).toContain(
            `truncated — ${MAX_READ_LENGTH + 100} chars total`,
        );
    });
});

/**
 * readReference reads only repositories this review was given: the reviewed
 * one, its linked repositories, and the repositories its skills and docs come
 * from. Anything else, a malformed repository name, or a path that climbs out
 * is refused before any request goes out.
 */
describe('readReference — which repositories it may read', () => {
    const originalFetch = (global as any).fetch;
    afterEach(() => {
        (global as any).fetch = originalFetch;
    });
    const ok = () => ({ status: 200, statusText: 'OK', body: 'content' });

    it('refuses a repository the review was not given, without a request', async () => {
        const calls = stubFetch(ok);

        const out = await readReference().execute({
            repo: 'acme-brewery/payroll',
            path: 'README.md',
        });

        expect(out).toMatch(
            /^Error: acme-brewery\/payroll is not a repository this review can read/,
        );
        expect(out).toContain('acme-brewery/style-guide');
        expect(calls).toHaveLength(0);
    });

    it.each([
        ['the reviewed repository', 'acme-brewery/app'],
        [
            'a repository its skills or docs come from',
            'acme-brewery/style-guide',
        ],
        ['the same, in other casing', 'Acme-Brewery/Style-Guide'],
    ])('reads %s', async (_label, repo) => {
        const calls = stubFetch(ok);

        const out = await readReference().execute({ repo, path: 'docs/a.md' });

        expect(out).toBe('content');
        expect(calls).toHaveLength(1);
    });

    it('reads a linked repository', async () => {
        const calls = stubFetch(ok);
        const linkedRepoAccess = {
            list: () => [
                {
                    repository: 'acme-brewery/recipes',
                    preferredRef: 'main',
                    status: 'ready',
                },
            ],
            ensureCloned: jest.fn(),
        } as any;
        const tool = buildAgentTools(
            makeRemote(),
            'test-token',
            'acme-brewery/app',
            undefined,
            undefined,
            undefined,
            linkedRepoAccess,
        ).readReference;

        const out = await tool.execute({
            repo: 'acme-brewery/recipes',
            path: 'a.md',
        });

        expect(out).toBe('content');
        expect(calls).toHaveLength(1);
    });

    it.each([
        ['no owner', 'style-guide'],
        ['a parent segment', 'acme-brewery/..'],
        ['an extra segment', 'acme-brewery/style-guide/issues'],
        ['a query', 'acme-brewery/style-guide?x=1'],
    ])(
        'refuses a repository name with %s, without a request',
        async (_label, repo) => {
            const calls = stubFetch(ok);

            const out = await readReference().execute({ repo, path: 'a.md' });

            expect(out).toMatch(/^Error: /);
            expect(calls).toHaveLength(0);
        },
    );

    it.each([
        ['climbs out', '../../users/acme-brewery'],
        ['climbs out midway', 'docs/../../../orgs/acme-brewery'],
        ['is absolute', '/etc/passwd'],
    ])('refuses a path that %s, without a request', async (_label, path) => {
        const calls = stubFetch(ok);

        const out = await readReference().execute({
            repo: 'acme-brewery/style-guide',
            path,
        });

        expect(out).toMatch(/^Error: /);
        expect(calls).toHaveLength(0);
    });
});
