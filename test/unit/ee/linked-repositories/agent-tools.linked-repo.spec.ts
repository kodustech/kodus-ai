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
