// The runner drives the loop through LLM.run, which resolves the model via
// resolveModelConfig: mock it to inject a scripted model (no key, no network).
jest.mock('@libs/llm/model-invocation', () => ({ resolveModelConfig: jest.fn() }));

import { MockLanguageModelV3 } from 'ai/test';

import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import { type AuthoredWorkspace, checkAuthoredSubmission } from './authored-files-policy';
import { authorRecipe, recipeAuthorPrompt, recipeAuthorWorkspace, type RecipeAuthorWorkspaceRepository, SUBMIT_RECIPE_TOOL } from './recipe-author.agent';
import { fileExists, type RepoReader } from './repo-reader';
import { WorkspaceRepoReader } from './workspace-repo-reader';

// A synthetic pair: a shop API that calls a billing service, each its own repository.
const SHOP: Record<string, string> = {
    'package.json': '{"name":"shop","scripts":{"dev":"node server.js"}}',
    'package-lock.json': '{}',
    'server.js': 'require("http").createServer().listen(3000)',
    'docker-compose.yml': 'services:\n  app:\n    build: .\n  billing:\n    build: ../billing\n',
    Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node","server.js"]\n',
};
const BILLING: Record<string, string> = {
    'go.mod': 'module example.com/billing\n\ngo 1.23\n',
    'go.sum': '',
    'cmd/billing/main.go': 'package main\nfunc main() {}\n',
    Dockerfile: 'FROM golang:1.23-bookworm\nCOPY . .\nRUN go build -o /billing ./cmd/billing\nCMD ["/billing"]\n',
    '.nvmrc': '22\n',
};

function memory(files: Record<string, string>): RepoReader {
    return {
        list: async (dir) => {
            const prefix = dir ? `${dir}/` : '';
            const out = new Set<string>();
            for (const f of Object.keys(files)) {
                if (!f.startsWith(prefix)) continue;
                const rest = f.slice(prefix.length);
                out.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
            }
            return [...out].sort();
        },
        read: async (path) => files[path] ?? null,
        paths: async () => Object.keys(files).sort(),
    };
}

const SHA_SHOP = 'a'.repeat(40);
const SHA_BILLING = 'b'.repeat(40);
const MEMBERS: RecipeAuthorWorkspaceRepository[] = [
    { repositoryId: 'r-shop', fullName: 'acme/shop', alias: 'shop', role: 'primary', sha: SHA_SHOP },
    { repositoryId: 'r-billing', fullName: 'acme/billing-service', alias: 'billing', role: 'member', sha: SHA_BILLING },
];
const POLICY: AuthoredWorkspace = { primary: { fullName: 'acme/shop', alias: 'shop' }, members: [{ fullName: 'acme/billing-service', alias: 'billing' }] };

const reader = (shop = SHOP) => new WorkspaceRepoReader({ alias: 'shop', reader: memory(shop) }, [{ alias: 'billing', reader: memory(BILLING) }]);

/** checkAuthoredSubmission as the agent's submit tool calls it, over the workspace (or one repository when `ws` is undefined). */
async function check(recipe: string, files?: unknown, workspace: AuthoredWorkspace | null = POLICY, shop = SHOP) {
    const ws = workspace ?? undefined;
    const r = ws ? reader(shop) : memory(shop);
    return checkAuthoredSubmission(
        recipe,
        files,
        (p) => fileExists(r, p),
        (p) => r.read(p, 64 * 1024).catch(() => null),
        undefined,
        ws,
    );
}

const NEEDS = '  needs:\n    - { repo: acme/billing-service, alias: billing }\n';
const recipeOf = (needs = NEEDS, files = '[.kodus/compose.yaml]') =>
    `version: 1\nservices:\n  compose:\n    files: ${files}\n    public: app\n${needs}  expose:\n    - { service: app, port: 3000, kind: http }\n    - { service: billing, port: 8080, kind: http }\n`;

const KODUS_DOCKERFILE = 'FROM node:22-bookworm\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nCMD ["npm","run","dev"]\n';
const compose = (billing: string) =>
    `services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n    depends_on: [billing]\n  billing:\n${billing}`;
const filesWith = (billing: string) => [
    { path: '.kodus/Dockerfile', content: KODUS_DOCKERFILE },
    { path: '.kodus/compose.yaml', content: compose(billing) },
];

describe("Kody's compose files in a multi-repository environment", () => {
    it('builds ../<alias> with that repository Dockerfile when services.needs declares it', async () => {
        const r = await check(recipeOf(), filesWith('    build: { context: ../billing }\n'));
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.recipe?.needs).toEqual([{ repo: 'acme/billing-service', alias: 'billing' }]);
    });

    it('a bind of a member path is repository code: Kody files that copy nothing of the primary but bind the member are no placeholder', async () => {
        const only = (billing: string) => [
            { path: '.kodus/Dockerfile', content: 'FROM nginx:1.27\nCOPY .kodus/compose.yaml /etc/x.yaml\n' },
            { path: '.kodus/compose.yaml', content: `services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n  billing:\n    image: alpine:3.20\n${billing}` },
        ];
        const bound = await check(recipeOf(), only('    volumes:\n      - ../billing/cmd:/srv:ro\n'));
        expect(bound.errors).toEqual([]);
        // The same files without the bind boot none of the code.
        const none = await check(recipeOf(''), only(''));
        expect(none.errors).toEqual([expect.stringContaining("no service takes the repository's code")]);
    });

    it('building a member Dockerfile counts as repository code too', async () => {
        const r = await check(recipeOf(NEEDS, '[.kodus/compose.yaml]'), [{ path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: ../billing\n' }]);
        expect(r.errors).toEqual([]);
    });

    it('refuses ../<alias> of a repository that is not a member, naming the ones it may build', async () => {
        const r = await check(recipeOf(), filesWith('    build: { context: ../payments }\n'));
        expect(r.ok).toBe(false);
        expect(r.errors).toContain(
            '.kodus/compose.yaml services.billing.build.context: ../payments: ../payments is not a repository of this environment; name a path of this repository or ../<alias> of another repository of this environment (../billing)',
        );
    });

    it('refuses a path that leaves the workspace, and the workspace root itself', async () => {
        const up = await check(recipeOf(), filesWith('    build: { context: ../../etc }\n'));
        expect(up.errors).toContain(
            '.kodus/compose.yaml services.billing.build.context: ../../etc leaves the workspace; name a path of this repository or ../<alias> of another repository of this environment (../billing)',
        );
        const bind = await check(recipeOf(), filesWith('    build: ../billing\n    volumes:\n      - ../../home:/h\n'));
        expect(bind.errors).toContain(
            '.kodus/compose.yaml services.billing.volumes[0]: ../../home leaves the workspace; name a path of this repository or ../<alias> of another repository of this environment (../billing)',
        );
        const root = await check(recipeOf(), filesWith('    build: ..\n'));
        expect(root.errors.join('\n')).toContain('.. is the workspace itself, not a repository');
    });

    it('a member Dockerfile that is not at its commit says which repository', async () => {
        const r = await check(recipeOf(), filesWith('    build: { context: ../billing, dockerfile: deploy/Dockerfile }\n'));
        expect(r.errors).toContain('.kodus/compose.yaml services.billing.build.dockerfile: ../billing/deploy/Dockerfile is not in billing at its commit');
    });

    it('refuses a recipe that builds a member without declaring it in services.needs', async () => {
        const r = await check(recipeOf(''), filesWith('    build: { context: ../billing }\n'));
        expect(r.errors).toEqual([
            'services.needs: your compose files build or bind ../billing, so the recipe needs it; add - { repo: acme/billing-service, alias: billing }',
        ]);
    });

    it("requires the need when the primary's own compose file builds the member", async () => {
        const r = await check(recipeOf('', '[docker-compose.yml]'));
        expect(r.errors).toEqual([
            'services.needs: your compose files build or bind ../billing, so the recipe needs it; add - { repo: acme/billing-service, alias: billing }',
        ]);
        expect((await check(recipeOf(NEEDS, '[docker-compose.yml]'))).errors).toEqual([]);
    });

    it('refuses a need that is not a member, a member under another alias, and the primary itself', async () => {
        const files = filesWith('    build: { context: ../billing }\n');
        const extra = await check(recipeOf(`${NEEDS}    - { repo: acme/payments }\n`), files);
        expect(extra.errors).toEqual(['services.needs[1]: acme/payments is not a repository of this environment; the others are billing (acme/billing-service)']);
        const alias = await check(recipeOf('  needs:\n    - { repo: acme/billing-service }\n'), files);
        expect(alias.errors).toEqual([
            'services.needs[0]: acme/billing-service is in this environment under the alias billing (../billing); write alias: billing',
            'services.needs: your compose files build or bind ../billing, so the recipe needs it; add - { repo: acme/billing-service, alias: billing }',
        ]);
        const taken = await check(recipeOf('  needs:\n    - { repo: acme/other, alias: billing }\n'), files);
        expect(taken.errors[0]).toBe('services.needs[0]: alias billing is acme/billing-service in this environment, not acme/other');
        const own = await check(recipeOf(`${NEEDS}    - { repo: acme/shop, alias: shop2 }\n`), files);
        expect(own.errors).toEqual(["services.needs[1]: acme/shop is the environment's own repository; list only the other repositories of this environment"]);
    });

    it("keeps Kody's files under the primary's .kodus/: a member's .kodus/ is refused", async () => {
        const r = await check(recipeOf(), [...filesWith('    build: ../billing\n'), { path: '../billing/.kodus/Dockerfile', content: KODUS_DOCKERFILE }]);
        expect(r.errors).toEqual([
            `files: "../billing/.kodus/Dockerfile" is outside shop; Kody's files go only under this repository's .kodus/ (another repository's .kodus/ is never applied)`,
        ]);
    });

    it('one repository is checked exactly as before: ../<alias> is outside the repository and services.needs is no field Kody writes', async () => {
        const single = await check(recipeOf(), filesWith('    build: { context: ../billing }\n'), null);
        expect(single.errors).toEqual([
            '.kodus/compose.yaml services.billing.build.context: must be a directory of the repository, relative to its root',
            'services.needs: Kody does not write this field; leave it out',
        ]);
        // A workspace with no member is one repository.
        const empty = await check(recipeOf(), filesWith('    build: { context: ../billing }\n'), { primary: POLICY.primary, members: [] });
        expect(empty.errors).toEqual(single.errors);
    });
});

type Turn = { tool: string; input: unknown };

function scripted(turns: Turn[]) {
    const prompts: string[] = [];
    let i = 0;
    const model = new MockLanguageModelV3({
        doGenerate: (async (options: any) => {
            prompts.push(JSON.stringify({ prompt: options.prompt, tools: (options.tools ?? []).map((t: any) => t.name) }));
            const t = turns[Math.min(i++, turns.length - 1)];
            return {
                content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: t.tool, input: JSON.stringify(t.input) }],
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
                warnings: [],
            };
        }) as any,
    });
    (resolveModelConfig as jest.Mock).mockReturnValue({ model, callOptions: {}, providerOptions: {}, modelName: 'mock', usageIdentity: {} });
    return prompts;
}

const deps = () => ({
    runner: new AiSdkAgentRunner(undefined),
    reader: memory(SHOP),
    memberReader: (r: RecipeAuthorWorkspaceRepository) => {
        if (r.alias !== 'billing' || r.sha !== SHA_BILLING) throw new Error(`unexpected member ${r.alias}`);
        return memory(BILLING);
    },
});
const input = { runId: 'r1', repositoryName: 'acme/shop', sha: SHA_SHOP, workspace: MEMBERS };
const answerOf = (prompts: string[], step: number) => JSON.stringify(JSON.parse(prompts[step]).prompt.at(-1));

describe('authorRecipe over a workspace', () => {
    it('explains the layout, labels each repository facts, reads ../<alias>, and returns a recipe that needs the member', async () => {
        const files = filesWith('    build: { context: ../billing }\n');
        const prompts = scripted([
            { tool: 'list_files', input: { path: '..' } },
            { tool: 'read_file', input: { path: '../billing/go.mod' } },
            { tool: 'read_file', input: { path: '../payments/go.mod' } },
            { tool: 'find_files', input: { glob: 'Dockerfile' } },
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: recipeOf(''), files } },
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: recipeOf(), files } },
        ]);
        const r = await authorRecipe(deps(), input);
        expect(r).toMatchObject({ status: 'submitted', recipe: recipeOf() });
        expect(r.status === 'submitted' && r.files?.map((f) => f.path)).toEqual(['.kodus/Dockerfile', '.kodus/compose.yaml']);
        expect(r.rejected).toEqual([
            ['services.needs: your compose files build or bind ../billing, so the recipe needs it; add - { repo: acme/billing-service, alias: billing }'],
        ]);

        const first = prompts[0];
        // Where each other repository is and at which commit, the services.needs entry it takes, and each repository's facts.
        expect(first).toContain(`- ../billing/: acme/billing-service at ${SHA_BILLING}`);
        expect(first).toContain('    - { repo: acme/billing-service, alias: billing }');
        expect(first).toContain('Node 22 [.nvmrc]');
        expect(answerOf(prompts, 1)).toContain('billing/\\nshop/');
        expect(answerOf(prompts, 2)).toContain('module example.com/billing');
        expect(answerOf(prompts, 3)).toContain('../payments is not a repository of this environment; the repositories are ../shop, ../billing');
        expect(answerOf(prompts, 4)).toContain('Dockerfile\\n../billing/Dockerfile');
    });

    it('a workspace of the primary alone is one repository: the same prompt, and no member reader is asked for', async () => {
        const alone = [MEMBERS[0]];
        const base = { repositoryName: 'acme/shop', sha: SHA_SHOP };
        expect(recipeAuthorPrompt({ ...base, workspace: alone })).toBe(recipeAuthorPrompt(base));
        expect(recipeAuthorWorkspace(memory(SHOP), { sha: SHA_SHOP, workspace: alone })).toBeUndefined();
        expect(recipeAuthorWorkspace(memory(SHOP), { sha: SHA_SHOP })).toBeUndefined();

        const one = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: '' } }]);
        await authorRecipe({ runner: new AiSdkAgentRunner(undefined), reader: memory(SHOP) }, { runId: 'r1', ...base });
        const two = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: '' } }]);
        await authorRecipe({ runner: new AiSdkAgentRunner(undefined), reader: memory(SHOP) }, { runId: 'r1', ...base, workspace: alone });
        expect(two).toEqual(one);
    });

    it('single mode puts each repository decisive files in the prompt under its path', async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: '' } }]);
        await authorRecipe(deps(), { ...input, mode: 'single' });
        expect(JSON.parse(prompts[0]).tools).toEqual([SUBMIT_RECIPE_TOOL]);
        expect(prompts[0]).toContain('--- ../billing/Dockerfile ---');
        expect(prompts[0]).toContain('--- docker-compose.yml ---');
    });

    it('refuses a workspace list the caller should never send', () => {
        const r = memory(SHOP);
        const read = () => memory(BILLING);
        expect(() => recipeAuthorWorkspace(r, { sha: SHA_SHOP, workspace: MEMBERS })).toThrow('members need deps.memberReader');
        expect(() => recipeAuthorWorkspace(r, { sha: SHA_BILLING, workspace: MEMBERS }, read)).toThrow("the primary's sha is the run's sha");
        expect(() => recipeAuthorWorkspace(r, { sha: SHA_SHOP, workspace: [MEMBERS[0], { ...MEMBERS[1], alias: 'shop' }] }, read)).toThrow('alias shop twice');
        expect(() => recipeAuthorWorkspace(r, { sha: SHA_SHOP, workspace: [MEMBERS[1]] }, read)).toThrow('exactly one primary');
        expect(() => recipeAuthorWorkspace(r, { sha: SHA_SHOP, workspace: [MEMBERS[0], { ...MEMBERS[1], sha: 'main' }] }, read)).toThrow('billing has no 40-hex commit');
        expect(recipeAuthorWorkspace(r, { sha: SHA_SHOP, workspace: MEMBERS }, read)?.policy).toEqual(POLICY);
    });
});
