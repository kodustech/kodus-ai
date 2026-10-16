/**
 * The conversation eval gives its agent the Kodus MCP an organization with a
 * connected GitHub has, run in-process from production's classes over
 * in-memory stores and a PR remote answering as GitHub. If that wiring breaks,
 * the agent connects to nothing and answers without MCP, so what the agent
 * gets from it is pinned here: the connection, the tools, a read that goes
 * through GithubService to the PR, and a write that lands in the org's store
 * and only there.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
const { writePullRequestRemote } = require('./pr-remote');
const { startGithubRest } = require('./github-rest');
const { startKodusMcp } = require('./kodus-mcp');
const { connectMcpTools } = require('../../libs/agents/infrastructure/services/ai-sdk/mcp-tools');

const OWNER = 'acme';
const REPOSITORY = { id: '41000001', name: 'service', fullName: 'acme/service' };
const org = (n: number) => ({
    organizationId: `00000000-0000-4000-8000-0000000000a${n}`,
    teamId: `00000000-0000-4000-8000-0000000000b${n}`,
});
const FILES = {
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
};

describe('kodus mcp — the org stack the conversation eval runs', () => {
    let pr: any;
    let github: any;
    let kodus: any;
    const opened: any[] = [];

    const connect = async (o: { organizationId: string; teamId: string }) => {
        const servers = await kodus.mcpManagerService.getConnections(o);
        const mcp = await connectMcpTools(servers);
        opened.push(mcp);
        return { servers, mcp };
    };
    const call = async (mcp: any, name: string, args: object) => JSON.parse(await mcp.tools[name].execute(args, { toolCallId: 't', messages: [] })).structuredContent;

    beforeAll(async () => {
        pr = writePullRequestRemote({ files: FILES, changed: ['src/b.ts'] });
        github = await startGithubRest({ pr, owner: OWNER, repository: REPOSITORY });
        kodus = await startKodusMcp();
        for (const n of [1, 2]) {
            kodus.addOrganization({
                organizationAndTeamData: org(n),
                language: 'en-US',
                github: { host: github.host, owner: OWNER },
                repository: REPOSITORY,
                pullRequest: { number: pr.number, title: pr.message, status: 'open', repository: REPOSITORY, user: { id: 1, username: 'dev' }, files: [] },
            });
        }
    }, 60_000);

    afterAll(async () => {
        for (const mcp of opened) await mcp.close();
        await kodus?.close();
        await github?.close();
        pr?.cleanup();
    });

    it('hands the agent the Kodus MCP connection with its tools', async () => {
        const { servers, mcp } = await connect(org(1));

        expect(servers).toHaveLength(1);
        expect(servers[0]).toMatchObject({ provider: 'kodusmcp', type: 'http', url: `${process.env.API_KODUS_MCP_SERVER_URL}` });
        expect(servers[0].headers.Authorization).toMatch(/^Bearer /);
        expect(Object.keys(mcp.tools)).toEqual(expect.arrayContaining(['KODUS_FIND_MEMORIES', 'KODUS_CREATE_MEMORY', 'KODUS_CREATE_KODY_RULE', 'KODUS_GET_PULL_REQUEST_DIFF']));
    }, 30_000);

    it('reads the pull request through GithubService from the PR remote', async () => {
        const { mcp } = await connect(org(1));
        const diff = await call(mcp, 'KODUS_GET_PULL_REQUEST_DIFF', { ...org(1), repositoryId: REPOSITORY.id, prNumber: pr.number });

        expect(diff.data).toContain('=== FILE: src/b.ts ===');
        expect(diff.data).toContain('+export const b = 2;');
        expect(github.misses).toEqual([]);
    }, 30_000);

    it("writes a memory into the org's store and only there", async () => {
        const { mcp } = await connect(org(1));
        await call(mcp, 'KODUS_CREATE_MEMORY', { ...org(1), kodyRule: { title: 'Constants', rule: 'Exported constants stay numeric.', repositoryId: REPOSITORY.id } });

        expect(kodus.writtenBy(org(1).organizationId).rules).toEqual([expect.objectContaining({ type: 'memory', title: 'Constants', status: 'active' })]);
        expect((await call(mcp, 'KODUS_FIND_MEMORIES', org(1))).count).toBe(1);

        const other = await connect(org(2));
        expect(kodus.writtenBy(org(2).organizationId).rules).toEqual([]);
        expect((await call(other.mcp, 'KODUS_FIND_MEMORIES', org(2))).count).toBe(0);
    }, 30_000);
});
