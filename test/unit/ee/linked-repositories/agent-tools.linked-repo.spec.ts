import { buildAgentTools } from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import type { LinkedRepoAccess } from '@libs/ee/linked-repositories';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

function makeRemote(over: Partial<RemoteCommands> = {}): RemoteCommands {
    return {
        grep: async () => 'pr-repo:1:match',
        read: async () => 'pr content',
        listDir: async () => 'src\nlib',
        exec: async () => ({ stdout: 'src/a.ts:1:hit', stderr: '', exitCode: 0 }),
        ...over,
    };
}

function makeLinkedAccess(
    over: Partial<LinkedRepoAccess> = {},
): LinkedRepoAccess {
    return {
        list: () => [
            {
                repository: 'org/backend-api',
                preferredRef: 'main',
                status: 'pending',
                instructions: 'API',
            },
        ],
        ensureCloned: async () => ({
            ok: true as const,
            rootPath: '/home/user/_linked/org_backend-api',
            repository: 'org/backend-api',
            ref: 'main',
        }),
        getMetadata: () => ({
            configured: 1,
            resolved: 1,
            cloned: 1,
            failed: 0,
            warnings: [],
            repositories: [],
        }),
        ...over,
    };
}

describe('buildAgentTools — linked repo param', () => {
    it('does not expose repo param when linkedRepoAccess is absent', () => {
        const tools = buildAgentTools(makeRemote());
        const schema = (tools.grep.inputSchema as any).jsonSchema;
        expect(schema.properties.repo).toBeUndefined();
    });

    it('exposes repo param when linkedRepoAccess is present', () => {
        const tools = buildAgentTools(
            makeRemote(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            makeLinkedAccess(),
        );
        const schema = (tools.grep.inputSchema as any).jsonSchema;
        expect(schema.properties.repo).toBeDefined();
        expect(tools.grep.description).toContain('org/backend-api');
    });

    it('routes grep with repo= to the linked root via exec', async () => {
        const execCalls: string[] = [];
        const tools = buildAgentTools(
            makeRemote({
                exec: async (cmd) => {
                    execCalls.push(cmd);
                    return {
                        stdout: 'src/error.ts:10:message',
                        stderr: '',
                        exitCode: 0,
                    };
                },
            }),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            makeLinkedAccess(),
        );

        const out = await tools.grep.execute({
            pattern: 'errorBody',
            repo: 'org/backend-api',
        });
        expect(execCalls[0]).toContain('/home/user/_linked/org_backend-api');
        expect(out).toContain('[org/backend-api]');
        expect(out).toContain('message');
    });

    it('rejects path traversal in linked-repo reads', async () => {
        const tools = buildAgentTools(
            makeRemote(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            makeLinkedAccess(),
        );
        const out = await tools.readFile.execute({
            path: '../../etc/passwd',
            repo: 'org/backend-api',
        });
        expect(out).toContain('Path traversal');
    });

    it.each(['app/[...slug]/page.tsx', 'app/(..)photo/page.tsx'])(
        'reads, greps and lists %p in a linked repo',
        async (routePath) => {
            const reads: string[] = [];
            const execCalls: string[] = [];
            const tools = buildAgentTools(
                makeRemote({
                    read: async (p) => {
                        reads.push(p);
                        return 'export default function Page() {}';
                    },
                    exec: async (cmd) => {
                        execCalls.push(cmd);
                        return {
                            stdout: 'page.tsx:1:hit',
                            stderr: '',
                            exitCode: 0,
                        };
                    },
                }),
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                makeLinkedAccess(),
            );

            const read = await tools.readFile.execute({
                path: routePath,
                repo: 'org/backend-api',
            });
            expect(read).not.toContain('Path traversal');
            expect(reads).toEqual([routePath]);

            const dir = routePath.replace(/\/page\.tsx$/, '');
            const grep = await tools.grep.execute({
                pattern: 'Page',
                path: dir,
                repo: 'org/backend-api',
            });
            expect(grep).not.toContain('Path traversal');
            const list = await tools.listDir.execute({
                path: dir,
                repo: 'org/backend-api',
            });
            expect(list).not.toContain('Path traversal');
            expect(execCalls).toHaveLength(2);
        },
    );

    it.each(['a/../../etc/passwd', '..\\..\\etc\\passwd'])(
        'refuses %p in linked-repo reads, greps and listings',
        async (escapePath) => {
            const exec = jest.fn();
            const read = jest.fn();
            const tools = buildAgentTools(
                makeRemote({ exec, read }),
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                makeLinkedAccess(),
            );
            for (const out of [
                await tools.readFile.execute({
                    path: escapePath,
                    repo: 'org/backend-api',
                }),
                await tools.grep.execute({
                    pattern: 'x',
                    path: escapePath,
                    repo: 'org/backend-api',
                }),
                await tools.listDir.execute({
                    path: escapePath,
                    repo: 'org/backend-api',
                }),
            ]) {
                expect(out).toContain('Path traversal');
            }
            expect(exec).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
        },
    );

    it('returns error for unknown linked repo', async () => {
        const tools = buildAgentTools(
            makeRemote(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            makeLinkedAccess({
                ensureCloned: async () => ({
                    ok: false as const,
                    error: 'Unknown linked repository "nope"',
                }),
            }),
        );
        const out = await tools.grep.execute({
            pattern: 'x',
            repo: 'nope',
        });
        expect(out).toContain('Unknown linked repository');
    });

    it('tags linked readFile output as evidence-only', async () => {
        const tools = buildAgentTools(
            makeRemote({
                exec: async () => ({
                    stdout: 'return { message: err };',
                    stderr: '',
                    exitCode: 0,
                }),
            }),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            makeLinkedAccess(),
        );
        const out = await tools.readFile.execute({
            path: 'src/error.ts',
            startLine: 1,
            endLine: 5,
            repo: 'org/backend-api',
        });
        expect(out).toContain('evidence only');
        expect(out).toContain('do NOT set relevantFile');
    });
});
