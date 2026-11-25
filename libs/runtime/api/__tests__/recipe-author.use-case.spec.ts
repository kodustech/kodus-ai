// The runner drives the loop through LLM.run, which resolves the model via
// resolveModelConfig: mock it to inject a scripted model (no key, no network).
jest.mock('@libs/llm/model-invocation', () => ({ resolveModelConfig: jest.fn() }));

import { RECIPE_AUTHOR_VERSION, recipeAuthorRevision } from '@libs/runtime/run/recipe-author-version';
import { declareMirrorBuildArgs } from '../application/recipe-author/authored-dockerfile-mirror';
import { BadGatewayException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { MockLanguageModelV3 } from 'ai/test';

import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { LLM_TASK } from '@libs/llm/llm-tasks';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { type EnvironmentSetupRecord, setupLearnScopeId } from '@libs/runtime/run';

import * as policy from '../application/recipe-author/authored-files-policy';
import { GitRepoReader } from '../application/recipe-author/git-repo-reader';
import { RECIPE_AUTHOR_LIMITS, SUBMIT_RECIPE_TOOL } from '../application/recipe-author/recipe-author.agent';
import { RECIPE_AUTHOR_LEASE_MS, RECIPE_AUTHOR_TASK, RuntimeRecipeAuthorUseCase } from '../application/use-cases/recipe-author.use-case';
import { signRunToken, signSetupToken } from '../domain/run-token';
import type { ProductEnvironment, RuntimeAgentRunnerFactory, RuntimeGitPort } from '../domain/ports';
import type { RecipeAuthorClaim, RecipeAuthorOutcome, RecipeAuthorReceipts, RecipeAuthorReservation } from '../domain/setup-calls';
import { ByokRuntimeAgentRunnerFactory } from '../infrastructure/byok-runtime-llm.provider';
import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { clock, config, InMemoryEnvironmentRepositories, InMemoryLlmUsage, NOW, ORG, OTHER_ORG, REPO, SECRET, TEAM } from './fixtures';

// Kody writes a setup's recipe, product side (docs RECIPE-AGENT-TEST-PLAN,
// "Ligar ao produto"): the setup token, the setup it names, the commit read
// through the Git integration, the budget, and the checks on what comes back.

// The submission check, real unless a test scripts one answer (the agent's tool calls it first, the product again).
jest.mock('../application/recipe-author/authored-files-policy', () => {
    const actual = jest.requireActual('../application/recipe-author/authored-files-policy');
    return { ...actual, checkAuthoredSubmission: jest.fn(actual.checkAuthoredSubmission) };
});
const submission = policy.checkAuthoredSubmission as jest.MockedFunction<typeof policy.checkAuthoredSubmission>;

const KEY = 'env-1:2026-10-29T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const FAKE_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const BUDGET = { perRun: 500_000, perPullRequest: 1_000_000, perOrgPerDay: 5_000_000 };

const FILES: Record<string, string> = {
    'docker-compose.yml': 'services:\n  app:\n    build: .\n    ports: ["8080:3000"]\n  db:\n    image: postgres:16\n',
    Dockerfile: 'FROM node:22\nCMD ["npm","start"]\n',
    'package.json': '{"scripts":{"start":"node server.js"}}',
    '.env': `GITHUB_TOKEN=${FAKE_TOKEN}\n`,
    'src/server.js': 'require("http").createServer().listen(3000)',
};

const GOOD = `version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: app
    health: /health
  expose:
    - { service: app, port: 3000, kind: http }
`;

const setup = (over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: ORG,
    repositoryId: REPO,
    key: KEY,
    state: 'setting_up',
    steps: [{ name: 'recipe', state: 'running', startedAt: '2026-10-29T12:00:01.000Z' }],
    blockers: [],
    sha: SHA,
    branch: 'main',
    refSource: 'default_branch',
    requestedAt: '2026-10-29T12:00:00.000Z',
    updatedAt: '2026-10-29T12:00:01.000Z',
    ...over,
});

const product: ProductEnvironment = {
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'setup_requested',
    createdAt: '',
    updatedAt: '',
};

const bearer = (patch: Record<string, unknown> = {}) =>
    `Bearer ${signSetupToken({ setupKey: KEY, environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 3_600, ...patch } as any, SECRET)}`;

/** The Git integration at one commit: the tree API and readFileAtCommit, recording every call. */
function fakeGit(files = FILES) {
    const calls: string[] = [];
    const git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'listFilesAtCommit'> = {
        listFilesAtCommit: async (i) => {
            calls.push(`list ${i.repositoryName}@${i.sha.slice(0, 4)}`);
            return i.sha === SHA ? Object.keys(files) : [];
        },
        readFileAtCommit: async (i) => {
            calls.push(`read ${i.path}@${i.sha.slice(0, 4)}`);
            if (i.sha !== SHA) return null;
            const text = files[i.path];
            if (text !== undefined && Buffer.byteLength(text) > i.maxBytes) throw new Error('too large');
            return text ?? null;
        },
    };
    return { git, calls };
}

type Turn = { tool: string; input: unknown };

/** A model that plays the turns in order and records every prompt it was sent. */
function scripted(turns: Turn[]) {
    const prompts: string[] = [];
    let i = 0;
    const model = new MockLanguageModelV3({
        doGenerate: (async (options: any) => {
            prompts.push(JSON.stringify(options.prompt));
            const t = turns[Math.min(i++, turns.length - 1)];
            return {
                content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: t.tool, input: JSON.stringify(t.input) }],
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: { inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } },
                warnings: [],
            };
        }) as any,
    });
    (resolveModelConfig as jest.Mock).mockReturnValue({ model, callOptions: {}, providerOptions: {}, modelName: 'mock', usageIdentity: {} });
    return prompts;
}

function make(
    opts: {
        setup?: EnvironmentSetupRecord | null;
        files?: Record<string, string>;
        runners?: RuntimeAgentRunnerFactory;
        budget?: typeof BUDGET;
        /** The product's memory of each attempt, shared by the instances of one test as by the API's across a restart. */
        receipts?: RecipeAuthorReceipts;
        /** The org's Outbound access switch for the recommended list. */
        recommendedEnabled?: boolean;
        usage?: InMemoryLlmUsage;
        now?: () => Date;
        /** The repository's open pull requests and the paths each changes; 'fails' makes the listing throw. */
        openPullRequests?: Array<{ number: number; updatedAt: string; paths: string[] }> | 'fails';
    } = {},
) {
    const usage = opts.usage ?? new InMemoryLlmUsage();
    const { git: base, calls } = fakeGit(opts.files);
    const open = opts.openPullRequests;
    const git: Partial<RuntimeGitPort> = open
        ? {
              ...base,
              listOpenPullRequests: async () => {
                  if (open === 'fails') throw new Error('Git API down');
                  return open.map((pr) => ({ number: pr.number, headSha: 'f'.repeat(40), updatedAt: pr.updatedAt }));
              },
              getPullRequestDiff: async (i) => ({
                  files: (open as Exclude<typeof open, 'fails'>).find((pr) => pr.number === i.prNumber)!.paths.map((path) => ({ path, patch: '' })) as any,
                  truncated: false,
              }),
          }
        : base;
    const record = opts.setup === undefined ? setup() : opts.setup;
    const setups = { get: jest.fn(async (org: string, env: string) => (record && record.organizationId === org && record.environmentId === env ? record : null)) };
    const products = { get: jest.fn(async (org: string, env: string) => (org === ORG && env === 'env-1' ? product : null)) };
    const runnerCalls: unknown[] = [];
    const runners: RuntimeAgentRunnerFactory = opts.runners ?? {
        forOrganization: async (orgTeam) => {
            runnerCalls.push(orgTeam);
            return { runner: new AiSdkAgentRunner(undefined), model: 'mock-model' };
        },
    };
    const uc = new RuntimeRecipeAuthorUseCase(
        config({ llmBudget: opts.budget ?? BUDGET }),
        opts.now ?? clock,
        usage,
        git as RuntimeGitPort,
        products,
        runners,
        setups,
        undefined,
        undefined,
        opts.receipts,
        opts.recommendedEnabled === undefined ? undefined : { settings: async () => ({ recommendedEnabled: opts.recommendedEnabled!, whoMayAdd: 'owners' as const }) },
    );
    return { uc, usage, calls, runnerCalls };
}

describe('POST /internal/runtime/recipe-author', () => {
    it('reads the setup commit through the Git integration, returns the checked recipe and counts the run on the setup budget', async () => {
        const prompts = scripted([
            { tool: 'list_files', input: { path: '' } },
            { tool: 'read_file', input: { path: 'docker-compose.yml' } },
            { tool: 'read_file', input: { path: '.env' } },
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD, notes: `The root compose file. ${FAKE_TOKEN}` } },
        ]);
        const t = make();
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out).toMatchObject({ status: 'submitted', recipe: GOOD, usage: { inputTokens: 4_000, outputTokens: 200 } });
        // Model text is redacted before it leaves the product.
        expect(out.status === 'submitted' && out.notes).toMatch(/^The root compose file\./);
        expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
        // The org and team of the token pick the slot.
        expect(t.runnerCalls).toEqual([{ organizationId: ORG, teamId: TEAM }]);
        // Every read is at the setup's commit, of the product's repository.
        expect(t.calls[0]).toBe(`list acme/shop@${SHA.slice(0, 4)}`);
        expect(t.calls.every((c) => c.endsWith(`@${SHA.slice(0, 4)}`))).toBe(true);
        // S3: the .env values never reached the model.
        expect(prompts.join('\n')).toContain('GITHUB_TOKEN');
        expect(prompts.join('\n')).not.toContain(FAKE_TOKEN);
        // S-47: one settled row under the setup's scope id, prNumber 0, with what the model reported.
        expect(t.usage.rows).toEqual([
            expect.objectContaining({
                runId: setupLearnScopeId(KEY),
                organizationId: ORG,
                repositoryId: REPO,
                prNumber: 0,
                task: RECIPE_AUTHOR_TASK,
                inputTokens: 4_000,
                outputTokens: 200,
                model: 'mock-model',
                pending: false,
            }),
        ]);
    });

    it('tells Kody which apps the open pull requests change, so it boots the app the Runs test, not the easiest one', async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make({
            openPullRequests: [
                { number: 3, updatedAt: '2026-11-20T10:00:00Z', paths: ['apps/dashboard/src/a.ts'] },
                { number: 4, updatedAt: '2026-11-21T10:00:00Z', paths: ['apps/dashboard/src/b.ts', 'apps/landing/index.ts'] },
            ],
        });
        await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(prompts[0]).toContain('open pull requests change: apps/dashboard (2 of 2), apps/landing (1 of 2)');
    });

    it('a Git API that fails to list the open pull requests leaves the fact out; the author still runs', async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const out = await make({ openPullRequests: 'fails' }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out).toMatchObject({ status: 'submitted', recipe: GOOD });
        expect(prompts[0]).not.toContain('- open pull requests change:');
    });

    it("answers no_recipe with Kody's reason when it finds nothing to boot", async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: '', notes: 'only docs, no compose file and no Dockerfile' } }]);
        const out = await make({ files: { 'README.md': '# docs' } }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out).toMatchObject({ status: 'no_recipe', reason: 'Kody found nothing to boot: only docs, no compose file and no Dockerfile' });
    });

    it('never returns a recipe the authored-recipe checks refuse (S2, S6)', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD.replace('version: 1', 'version: 1\negress: "*"') } }]);
        const out = await make().uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out.status).toBe('no_recipe');
        expect(JSON.stringify(out)).not.toContain('egress');
    });

    it('checks the submitted recipe again on the commit, whatever the agent decided', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        // The agent's tool accepts; the product's own check, on the same commit, has the last word.
        const real = jest.requireActual('../application/recipe-author/authored-files-policy').checkAuthoredSubmission;
        const spy = submission
            .mockImplementationOnce(real)
            .mockImplementationOnce(async () => ({ ok: false, errors: ['services.compose.files: docker-compose.yml is not in the repository at this commit'] }));
        try {
            const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
            expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(out).toMatchObject({ status: 'no_recipe' });
            expect(out.status === 'no_recipe' && out.reason).toMatch(/^the checks refused the recipe: .*docker-compose\.yml/);
        } finally {
            spy.mockClear();
        }
    });

    const KODY_DOCKERFILE = 'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "src/server.js"]\n';
    const KODY_COMPOSE = 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n';
    const KODY_RECIPE = GOOD.replace('files: [docker-compose.yml]', 'files: [.kodus/compose.yaml]');
    const KODY_FILES = [
        { path: '.kodus/Dockerfile', content: KODY_DOCKERFILE },
        { path: '.kodus/compose.yaml', content: KODY_COMPOSE },
    ];

    it('returns the files Kody wrote with the recipe, checked laid over the commit and never redacted', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: KODY_FILES } }]);
        const t = make({ files: { 'package.json': FILES['package.json'], 'src/server.js': FILES['src/server.js'] } });
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out).toMatchObject({ status: 'submitted', recipe: KODY_RECIPE, files: KODY_FILES });
        // Existence comes from the one listing: no file is fetched only to learn it is there.
        expect(t.calls.filter((c) => c.startsWith('list'))).toHaveLength(1);
        expect(t.calls.filter((c) => c.startsWith('read .kodus/'))).toEqual([]);
    });

    // kr-mono on dev: Kodus adds the suite block from the CI after the agent's checks, and the product's final check then
    // refused every recipe Kody wrote for a repository whose CI runs an e2e suite ("suite: Kody does not write this field").
    it("answers Kody's recipe with the suite block Kodus wrote from the CI: the final check judges the rest", async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: KODY_FILES } }]);
        const files = {
            'package.json': FILES['package.json'],
            'src/server.js': FILES['src/server.js'],
            '.github/workflows/e2e.yml': 'jobs:\n  cypress:\n    strategy:\n      matrix:\n        containers: [1, 2, 3]\n    steps:\n      - run: npx cypress run --browser chrome\n',
            'cypress.config.ts': "export default { e2e: { specPattern: 'cypress/e2e/**/*.cy.ts' } };",
        };
        const out = await make({ files }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out.status).toBe('submitted');
        const recipe = out.status === 'submitted' ? out.recipe : '';
        expect(recipe.startsWith(KODY_RECIPE.trimEnd())).toBe(true);
        expect(recipe).toMatch(/^suite:\n {2}runner: cypress$/m);
    });

    it('never returns files that would replace a repository file', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: KODY_FILES } }]);
        const t = make({ files: { ...FILES, '.kodus/Dockerfile': 'FROM node:22\n' } });
        // The agent's tool refuses it too; the final check is the product's, whatever the tool said.
        const spy = submission.mockImplementationOnce(async () => ({ ok: true, errors: [], files: KODY_FILES }));
        try {
            const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
            expect(out.status).toBe('no_recipe');
            expect(out.status === 'no_recipe' && out.reason).toContain('.kodus/Dockerfile is already in the repository');
            expect(out).not.toHaveProperty('files');
        } finally {
            spy.mockClear();
        }
    });

    it('a Git failure while the checks read the commit is no verdict: 502, never no_recipe', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        const git = fakeGit().git;
        let lists = 0;
        // The agent's run lists the tree; the product's check lists it again and the platform answers 502.
        git.listFilesAtCommit = async () => {
            throw new Error(`GitHub API 502 (${++lists})`);
        };
        (t.uc as any).git = git;
        const spy = submission.mockImplementationOnce(async () => ({ ok: true, errors: [] }));
        try {
            await expect(t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).rejects.toBeInstanceOf(BadGatewayException);
        } finally {
            // The agent's own listing may fail first (502 before any submission), leaving the scripted answer
            // queued: drop it, so the next case runs the real check.
            spy.mockReset();
            spy.mockImplementation(jest.requireActual('../application/recipe-author/authored-files-policy').checkAuthoredSubmission);
        }
        // A read that fails (rate limit, 5xx) is no "not there" either.
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const u = make();
        const reads = fakeGit().git;
        reads.readFileAtCommit = async () => {
            throw new Error('GitHub API rate limit exceeded');
        };
        reads.listFilesAtCommit = undefined;
        (u.uc as any).git = reads;
        submission.mockImplementationOnce(async () => ({ ok: true, errors: [] }));
        await expect(u.uc.execute({ authorization: bearer(), body: { sha: SHA } })).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('a settle that fails after a good run still returns the recipe Kody wrote', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        t.usage.settle = async () => {
            throw new Error('database down');
        };
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out).toMatchObject({ status: 'submitted', recipe: GOOD });
    });

    it('refuses without a valid setup token, before any read or model call', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        const runToken = signRunToken({ runId: 'r', attempt: 1, organizationId: ORG, teamId: TEAM, repositoryId: REPO, prNumber: 1, exp: NOW.getTime() / 1000 + 60 }, SECRET);
        // Signed with another secret: the signature does not hold.
        const forged = `Bearer ${signSetupToken({ setupKey: KEY, environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 3_600 }, 'y'.repeat(48))}`;
        for (const authorization of [undefined, 'Bearer nope', `Bearer ${runToken}`, bearer({ exp: NOW.getTime() / 1000 - 1 }), forged]) {
            await expect(t.uc.execute({ authorization, body: { sha: SHA } })).rejects.toBeInstanceOf(UnauthorizedException);
        }
        expect(t.calls).toEqual([]);
        expect(t.runnerCalls).toEqual([]);
        expect(t.usage.rows).toEqual([]);
    });

    it('serves only the running default-branch setup the token names, at its commit', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const cases: Array<[EnvironmentSetupRecord | null, unknown, new (...a: any[]) => Error]> = [
            [null, { sha: SHA }, NotFoundException],
            [setup({ key: 'env-1:later' }), { sha: SHA }, ConflictException],
            [setup({ repositoryId: 'repo-2' }), { sha: SHA }, ConflictException],
            [setup({ state: 'active' }), { sha: SHA }, ConflictException],
            [setup({ refSource: 'dev_override' }), { sha: SHA }, ForbiddenException],
            [setup(), { sha: 'b'.repeat(40) }, ForbiddenException],
        ];
        for (const [record, body, error] of cases) {
            const t = make({ setup: record });
            await expect(t.uc.execute({ authorization: bearer(), body })).rejects.toBeInstanceOf(error);
            expect(t.calls).toEqual([]);
            expect(t.usage.rows).toEqual([]);
        }
        await expect(make().uc.execute({ authorization: bearer(), body: { sha: SHA, extra: 1 } })).rejects.toThrow(/Unrecognized key/);
        await expect(make().uc.execute({ authorization: bearer({ environmentId: 'env-2' }), body: { sha: SHA } })).rejects.toBeInstanceOf(NotFoundException);
        // A setup token of another org never reaches this org's setup, even for the same environment id.
        const other = make();
        await expect(other.uc.execute({ authorization: bearer({ organizationId: OTHER_ORG }), body: { sha: SHA } })).rejects.toBeInstanceOf(NotFoundException);
        expect(other.calls).toEqual([]);
        expect(other.usage.rows).toEqual([]);
    });

    it('503 when the org has no LLM for the Runtime; 429 when the setup budget cannot hold a run', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        await expect(make({ runners: { forOrganization: async () => null } }).uc.execute({ authorization: bearer(), body: { sha: SHA } })).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        const t = make();
        const err = await t.uc.execute({ authorization: bearer({ maxTokens: 5_000 }), body: { sha: SHA } }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(429);
        expect(err.getResponse()).toMatchObject({ code: 'llm_budget_exceeded', scope: 'run' });
        expect(t.calls).toEqual([]);
    });

    it("stops the agent run when the caller's request closes (the signal reaches the runner)", async () => {
        let seen: AbortSignal | undefined;
        const gone = new AbortController();
        const runner = {
            run: async (_spec: unknown, _input: unknown, ctx: { signal?: AbortSignal }) => {
                seen = ctx.signal;
                gone.abort();
                throw new Error('aborted');
            },
        };
        const t = make({ runners: { forOrganization: async () => ({ runner: runner as any }) } });
        await expect(t.uc.execute({ authorization: bearer(), body: { sha: SHA }, signal: gone.signal })).rejects.toThrow("Kody's model call failed");
        expect(seen?.aborted).toBe(true);
    });

    it("earlier setups of the repository never lock it out: a setup's tokens are no pull request's (prNumber 0 is the repository's, for good)", async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        // Older setups of the repository spent more than a pull request may, on other days.
        for (const [i, at] of ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z'].entries()) {
            await t.usage.record({ runId: setupLearnScopeId(`env-1:old-${i}`), organizationId: ORG, repositoryId: REPO, prNumber: 0, task: RECIPE_AUTHOR_TASK, inputTokens: 400_000, outputTokens: 0, at: new Date(at) });
        }
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out.status).toBe('submitted');
        // The setup's own ceiling still holds.
        const err = await make().uc.execute({ authorization: bearer({ maxTokens: 5_000 }), body: { sha: SHA } }).catch((e) => e);
        expect(err.getStatus()).toBe(429);
    });

    it("stops the run at what the setup's budget reserved, and keeps the reservation when the run fails", async () => {
        scripted([{ tool: 'list_files', input: { path: '' } }]);
        const t = make();
        const out = await t.uc.execute({ authorization: bearer({ maxTokens: 25_000 }), body: { sha: SHA } });
        expect(out.status).toBe('no_recipe');
        // 1 050 tokens a step: the run stops once it reached the 25 000 reserved.
        expect(out.usage.inputTokens + out.usage.outputTokens).toBeLessThanOrEqual(25_000 + 1_050);

        const failing = make({ runners: { forOrganization: async () => ({ runner: { run: async () => Promise.reject(new Error('boom')) } as any }) } });
        await expect(failing.uc.execute({ authorization: bearer(), body: { sha: SHA } })).rejects.toThrow("Kody's model call failed");
        expect(failing.usage.rows).toEqual([expect.objectContaining({ inputTokens: 400_000, outputTokens: 0, pending: false })]);
    });

    it('a model that fails mid-run is no verdict: 502 llm_unavailable, never no_recipe, and what the run reported is counted', async () => {
        // The harness turns a provider throw into a run that ended in error, with the steps made so far.
        const errored = { runId: 'r', agentId: 'a', status: 'error' as const, steps: [], artifacts: [], stopReason: 'error', usage: { inputTokens: 3_000, outputTokens: 10 }, trace: [] };
        const t = make({ runners: { forOrganization: async () => ({ runner: { run: async () => errored }, model: 'mock-model' }) } });
        const err = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } }).catch((e) => e);
        expect(err).toBeInstanceOf(BadGatewayException);
        expect(err.getResponse()).toEqual({ code: 'llm_unavailable', message: "Kody's model call failed" });
        expect(t.usage.rows).toEqual([expect.objectContaining({ inputTokens: 3_000, outputTokens: 10, pending: false })]);
    });

    it("a run that ended without a recipe on its own (no model error) stays Kody's no_recipe", async () => {
        const stopped = { runId: 'r', agentId: 'a', status: 'stopped' as const, steps: [], artifacts: [], usage: { inputTokens: 1, outputTokens: 1 }, trace: [] };
        const t = make({ runners: { forOrganization: async () => ({ runner: { run: async () => stopped } }) } });
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).toMatchObject({ status: 'no_recipe', reason: 'the run ended without a recipe' });
    });

    // kr-nocodb on release v1m: "the token budget ran out", one refusal, and no line said which check refused.
    it("logs why the checks refused Kody's recipes, in the checks' own words, cut", async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD.replace('version: 1', 'version: 1\negress: "*"') } }, { tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
        (t.uc as any).logger = logger;
        expect((await t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).status).toBe('submitted');
        const finished = logger.log.mock.calls.map((c) => c[0]).find((l) => l.message === 'Runtime recipe author finished');
        expect(finished.metadata.rejected).toBe(1);
        expect(finished.metadata.rejectedBecause).toEqual([[expect.stringContaining('egress')]]);
        expect(finished.metadata.rejectedBecause[0][0].length).toBeLessThanOrEqual(200);
    });

    it('the checks refusing every try is a verdict even when the last model call failed', async () => {
        const refusals = Array.from({ length: RECIPE_AUTHOR_LIMITS.maxRejected }, () => ({ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD.replace('version: 1', 'version: 1\negress: "*"') } }));
        scripted(refusals);
        const t = make();
        const runner = new AiSdkAgentRunner(undefined);
        const wrapped = { run: async (...a: Parameters<AiSdkAgentRunner['run']>) => ({ ...(await runner.run(...a)), status: 'error' as const }) };
        (t.uc as any).runners = { forOrganization: async () => ({ runner: wrapped }) };
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).toMatchObject({ status: 'no_recipe', reason: `the checks refused ${RECIPE_AUTHOR_LIMITS.maxRejected} recipes` });
    });

    it("a settle that fails after a failed run still answers 502, carrying the run's error and the settle's for the exception filter's one line, and logs nothing itself", async () => {
        const boom = new Error('provider exploded');
        const t = make({ runners: { forOrganization: async () => ({ runner: { run: async () => Promise.reject(boom) } as any }) } });
        t.usage.settle = async () => Promise.reject(new Error('database down'));
        const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
        (t.uc as any).logger = logger;
        const err = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } }).catch((e) => e);
        expect(err).toBeInstanceOf(BadGatewayException);
        expect(err).toMatchObject({ cause: boom, settleError: 'database down', failure: 'run' });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("names the org's day when it is the budget too tight for a run, not the setup's", async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make({ budget: { ...BUDGET, perOrgPerDay: 10_000 } });
        const err = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } }).catch((e) => e);
        expect(err.getStatus()).toBe(429);
        expect(err.getResponse()).toMatchObject({ code: 'llm_budget_exceeded', scope: 'org_day', spent: 0, limit: 10_000 });
        // The setup's own ceiling, when it is the tight one, is still the run's.
        const run = await make().uc.execute({ authorization: bearer({ maxTokens: 5_000 }), body: { sha: SHA } }).catch((e) => e);
        expect(run.getResponse()).toMatchObject({ scope: 'run', limit: 5_000 });
    });
});

describe('POST /internal/runtime/recipe-author with the last setup\'s recipe (RepoLaunch reuse)', () => {
    const KODY_DOCKERFILE = 'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY package.json ./\nRUN npm install\nCOPY . .\nCMD ["node", "src/server.js"]\n';
    const KODY_COMPOSE = 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n';
    const KODY_RECIPE = GOOD.replace('files: [docker-compose.yml]', 'files: [.kodus/compose.yaml]');
    const last = (over: Record<string, unknown> = {}) => ({
        recipe: KODY_RECIPE,
        files: [
            { path: '.kodus/Dockerfile', content: KODY_DOCKERFILE },
            { path: '.kodus/compose.yaml', content: KODY_COMPOSE },
        ],
        notes: 'Kody wrote a Dockerfile; the repository has none.',
        ...over,
    });
    const repo = { 'package.json': FILES['package.json'], 'src/server.js': FILES['src/server.js'] };

    it('answers the recipe that booted as is when it passes the checks at this commit: no runner, no model, no budget', async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const runners: RuntimeAgentRunnerFactory = { forOrganization: jest.fn(async () => null) };
        const t = make({ files: repo, runners });
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA, last: last() } });
        // Reused as is, but for the mirror's build args its Dockerfile now declares (G1: a build installs only through the mirror).
        const mirrored = last().files.map((f: { path: string; content: string }) => (f.path.endsWith('Dockerfile') ? { ...f, content: declareMirrorBuildArgs(f.path, f.content).content } : f));
        expect(out).toEqual({
            status: 'submitted', recipe: KODY_RECIPE, files: mirrored, notes: last().notes, reused: true, usage: { inputTokens: 0, outputTokens: 0 },
            adjusted: [expect.stringContaining("installs only through the cell's read-only mirror")],
        });
        expect(prompts).toEqual([]);
        expect(runners.forOrganization).not.toHaveBeenCalled();
        expect(t.usage.rows).toEqual([]);
        // Read at the setup's commit, like any submission.
        expect(t.calls.every((c) => c.endsWith(`@${SHA.slice(0, 4)}`))).toBe(true);
    });

    // The recipe Kodus answered carries its suite block: reused at the next setup, it passes the checks with it.
    it('reuses the last recipe with the suite block Kodus wrote from the CI', async () => {
        const runners: RuntimeAgentRunnerFactory = { forOrganization: jest.fn(async () => null) };
        const withSuite = `${KODY_RECIPE.trimEnd()}\n# suite: origin inferred from e2e.yml job cypress; keys: runner, command\nsuite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: cypress/e2e/**/*.cy.ts\n`;
        const out = await make({ files: repo, runners }).uc.execute({ authorization: bearer(), body: { sha: SHA, last: last({ recipe: withSuite }) } });
        expect(out).toMatchObject({ status: 'submitted', recipe: withSuite, reused: true });
        expect(runners.forOrganization).not.toHaveBeenCalled();
    });

    // The author's font rule follows the org's Outbound access switch: Google Fonts reaches a build only through the
    // recommended list (egress-lists.json v2).
    it("tells Kody when the organization turned the recommended egress list off, and only then", async () => {
        const files = { ...repo, 'app/layout.tsx': "import { Inter } from 'next/font/google';", 'package.json': '{"dependencies":{"next":"15.0.0"}}' };
        let prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: last().files } }]);
        await make({ files, recommendedEnabled: false }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(prompts[0]).toContain('this organization turned the Kodus recommended egress list off');
        prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: last().files } }]);
        await make({ files, recommendedEnabled: true }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(prompts[0]).not.toContain('recommended egress list off');
    });

    // demo-nextjs kept its next dev recipe after the author's instructions changed: a booted recipe was answered as is.
    it('a recipe that predates a revision recipes must get is written again by Kody, from it, and may stay the same', async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: last().files } }]);
        const t = make({ files: repo });
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA, last: last(), reauthor: { from: 1, to: RECIPE_AUTHOR_VERSION } } });
        expect(out).toMatchObject({ status: 'submitted', recipe: KODY_RECIPE, authorVersion: RECIPE_AUTHOR_VERSION });
        expect(out.status === 'submitted' && out.reused).toBeUndefined();
        expect(prompts[0]).toContain('written under older instructions than the ones above');
        expect(prompts[0]).toContain(recipeAuthorRevision(RECIPE_AUTHOR_VERSION)!.reason);
        // The model ran, on the setup's budget.
        expect(t.usage.rows.length).toBeGreaterThan(0);
    });

    it("when the checks refuse it at this commit, Kody starts from it and their errors, and never resubmits it", async () => {
        // At this commit package.json is gone: the Dockerfile's COPY reads a file that is not there.
        const prompts = scripted([
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: last().files } },
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } },
        ]);
        const { 'package.json': _gone, ...withoutManifest } = FILES;
        const t = make({ files: withoutManifest });
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA, last: last() } });
        expect(out).toMatchObject({ status: 'submitted', recipe: GOOD });
        expect(out.status === 'submitted' && out.reused).toBeUndefined();
        // Kody starts from what the checks say now.
        expect(prompts[0]).toContain('package.json is not in the repository at this commit');
    });

    it("with the failure of its last boot, Kody is asked at once, from that recipe and its blocker", async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make();
        const failure = { signature: 'setup:not_ready:app:3000/health', title: 'The app never answered its health check', evidence: ['GET /health on app:3000 answered 404'] };
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA, last: last({ failure }) } });
        expect(out).toMatchObject({ status: 'submitted', recipe: GOOD });
        expect(prompts[0]).toContain('GET /health on app:3000 answered 404');
        expect(t.usage.rows).toHaveLength(1);
    });

    it('refuses a last recipe out of its bounds before anything runs', async () => {
        await expect(make().uc.execute({ authorization: bearer(), body: { sha: SHA, last: { recipe: '' } } })).rejects.toThrow();
        await expect(make().uc.execute({ authorization: bearer(), body: { sha: SHA, last: last({ files: [{ path: '../x', content: '' }] }) } })).rejects.toThrow();
    });

    it('says what Kodus rewrote in the compose file of an answer', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: KODY_RECIPE, files: [last().files[0], { path: '.kodus/compose.yaml', content: `${KODY_COMPOSE}    container_name: shop\n` }] } }]);
        const out = await make({ files: repo }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        expect(out).toMatchObject({ status: 'submitted', adjusted: expect.arrayContaining([expect.stringContaining('container_name: dropped')]) });
        expect(out.status === 'submitted' && out.files?.[1].content).not.toContain('container_name');
    });
});

describe('GitRepoReader', () => {
    it('lists directories from one tree listing, and reads at the commit with the path checked again (S5)', async () => {
        const { git, calls } = fakeGit();
        const reader = new GitRepoReader(git, { organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', sha: SHA });
        expect(await reader.list('')).toEqual(['.env', 'Dockerfile', 'docker-compose.yml', 'package.json', 'src/']);
        expect(await reader.list('src')).toEqual(['server.js']);
        expect(calls.filter((c) => c.startsWith('list'))).toHaveLength(1);
        expect(await reader.read('package.json', 10)).toBe('{"scripts"');
        expect(await reader.read('missing.txt', 10)).toBeNull();
        await expect(reader.read('../etc/passwd', 10)).rejects.toThrow('the path leaves the repository');
        await expect(reader.list('/etc')).rejects.toThrow('relative');
    });

    it('answers exists from the one tree listing, and only reads when the platform cannot list', async () => {
        const { git, calls } = fakeGit();
        const target = { organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', sha: SHA };
        const reader = new GitRepoReader(git, target);
        expect(await reader.exists('Dockerfile')).toBe(true);
        expect(await reader.exists('./src/server.js')).toBe(true);
        expect(await reader.exists('src')).toBe(false);
        expect(await reader.exists('.kodus/Dockerfile')).toBe(false);
        expect(calls).toEqual([`list acme/shop@${SHA.slice(0, 4)}`]);
        await expect(reader.exists('../etc/passwd')).rejects.toThrow('the path leaves the repository');
        // A failed listing throws (never "not there"), and is asked again next time.
        let fail = true;
        const flaky = new GitRepoReader({ ...git, listFilesAtCommit: async (i) => (fail ? Promise.reject(new Error('502')) : git.listFilesAtCommit!(i)) }, target);
        await expect(flaky.exists('Dockerfile')).rejects.toThrow('502');
        fail = false;
        expect(await flaky.exists('Dockerfile')).toBe(true);
        // A platform that cannot list: a one-byte read, once per path.
        const unlisted = fakeGit();
        const byRead = new GitRepoReader({ readFileAtCommit: unlisted.git.readFileAtCommit, listFilesAtCommit: async () => 'unsupported_platform' }, target);
        expect(await byRead.exists('Dockerfile')).toBe(true);
        expect(await byRead.exists('missing')).toBe(false);
        expect(unlisted.calls).toEqual([`read Dockerfile@${SHA.slice(0, 4)}`, `read missing@${SHA.slice(0, 4)}`]);
    });

    it('a platform that cannot list says so to the agent instead of showing an empty repository', async () => {
        const reader = new GitRepoReader(
            { readFileAtCommit: async () => 'unsupported_platform', listFilesAtCommit: async () => 'unsupported_platform' },
            { organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', sha: SHA },
        );
        await expect(reader.list('')).rejects.toThrow('cannot list');
        await expect(reader.read('Dockerfile', 10)).rejects.toThrow('cannot read');
    });
});

describe('ByokRuntimeAgentRunnerFactory', () => {
    it('resolves LLM_TASK.runtime for the org and team, like the gateway; no slot and no managed key is no runner', async () => {
        const calls: unknown[] = [];
        const slot = { provider: 'openai_compatible', model: 'fake-model', apiKey: 'enc:x' } as any;
        const slots = { resolveTaskSlot: async (orgTeam: any, task: any) => (calls.push({ orgTeam, task }), slot) };
        const out = await new ByokRuntimeAgentRunnerFactory(slots, () => false).forOrganization({ organizationId: ORG, teamId: TEAM });
        expect(calls).toEqual([{ orgTeam: { organizationId: ORG, teamId: TEAM }, task: LLM_TASK.runtime }]);
        expect(out?.runner).toBeInstanceOf(AiSdkAgentRunner);
        expect(out?.model).toBe('fake-model');
        expect(await new ByokRuntimeAgentRunnerFactory({ resolveTaskSlot: async () => null }, () => false).forOrganization({ organizationId: ORG, teamId: TEAM })).toBeNull();
        expect(await new ByokRuntimeAgentRunnerFactory({ resolveTaskSlot: async () => null }, () => true).forOrganization({ organizationId: ORG, teamId: TEAM })).not.toBeNull();
    });
});

describe('POST /internal/runtime/recipe-author in an environment of several repositories', () => {
    const MEMBER_SHA = 'e'.repeat(40);
    const BILLING = 'repo-billing';
    const COMPOSE = 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n  billing:\n    build: { context: ../billing }\n';
    const DOCKERFILE = 'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY package.json ./\nRUN npm install\nCOPY . .\nCMD ["node", "src/server.js"]\n';
    const RECIPE = GOOD.replace('files: [docker-compose.yml]', 'files: [.kodus/compose.yaml]').replace(
        '  expose:',
        '  needs:\n    - { repo: acme/billing, alias: billing }\n  expose:',
    );
    const last = { recipe: RECIPE, files: [{ path: '.kodus/Dockerfile', content: DOCKERFILE }, { path: '.kodus/compose.yaml', content: COMPOSE }] };
    const trees: Record<string, Record<string, string>> = {
        [`acme/shop@${SHA}`]: { 'package.json': FILES['package.json'], 'src/server.js': FILES['src/server.js'] },
        [`acme/billing@${MEMBER_SHA}`]: { Dockerfile: 'FROM golang:1.23\nCMD ["/billing"]\n', 'main.go': 'package main' },
    };
    const git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'listFilesAtCommit'> & { calls: string[] } = {
        calls: [],
        listFilesAtCommit: async (i) => {
            git.calls.push(`list ${i.repositoryName}@${i.sha.slice(0, 4)}`);
            return Object.keys(trees[`${i.repositoryName}@${i.sha}`] ?? {});
        },
        readFileAtCommit: async (i) => {
            git.calls.push(`read ${i.repositoryName}:${i.path}@${i.sha.slice(0, 4)}`);
            return trees[`${i.repositoryName}@${i.sha}`]?.[i.path] ?? null;
        },
    };
    const record = setup({
        workspace: [
            { repositoryId: REPO, alias: 'shop', role: 'primary', sha: SHA, branch: 'main' },
            { repositoryId: BILLING, alias: 'billing', role: 'member', sha: MEMBER_SHA, branch: 'main' },
        ],
    });

    const make2 = (withMembers: boolean) => {
        const runners: RuntimeAgentRunnerFactory = { forOrganization: jest.fn(async () => null) };
        const products = { get: async (org: string, env: string) => (org === ORG && env === 'env-1' ? product : null), findByRepository: async () => null };
        const rows = new InMemoryEnvironmentRepositories([{ environmentId: 'env-1', organizationId: ORG }]);
        const members = new RuntimeEnvironmentMembers(products, rows);
        const uc = new RuntimeRecipeAuthorUseCase(
            config({ llmBudget: BUDGET }),
            clock,
            new InMemoryLlmUsage(),
            git as unknown as RuntimeGitPort,
            products,
            runners,
            { get: async () => record },
            undefined,
            withMembers ? members : undefined,
        );
        return { uc, rows, runners };
    };

    it("checks a reused recipe against the whole workspace: services.needs and ../billing pass, each repository read at its own commit", async () => {
        const t = make2(true);
        await t.rows.add({ environmentId: 'env-1', organizationId: ORG, repositoryId: REPO, repositoryName: 'acme/shop', fullName: 'acme/shop', role: 'primary', alias: 'shop', triggers: true, pairBranches: false });
        await t.rows.add({ environmentId: 'env-1', organizationId: ORG, repositoryId: BILLING, repositoryName: 'acme/billing', fullName: 'acme/billing', role: 'member', alias: 'billing', triggers: true, pairBranches: false });
        git.calls = [];
        const out = await t.uc.execute({ authorization: bearer(), body: { sha: SHA, last } });
        expect(out).toMatchObject({ status: 'submitted', recipe: RECIPE, reused: true });
        expect(t.runners.forOrganization).not.toHaveBeenCalled();
        // The member is read through its own repository, at the commit the setup boots it at.
        expect(git.calls.filter((c) => c.includes('acme/billing')).every((c) => c.endsWith(`@${MEMBER_SHA.slice(0, 4)}`))).toBe(true);
        expect(git.calls.some((c) => c.includes('acme/billing'))).toBe(true);
    });

    it('the same recipe checked as one repository fails on services.needs, and Kody is asked for another', async () => {
        const t = make2(false);
        await expect(t.uc.execute({ authorization: bearer(), body: { sha: SHA, last } })).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(t.runners.forOrganization).toHaveBeenCalled();
    });
});

/** The product's receipts of each (setupKey, attempt) in memory, with the semantics of TypeOrmRecipeAuthorReceipts (its integration suite holds Postgres to them). */
class InMemoryReceipts implements RecipeAuthorReceipts {
    readonly docs = new Map<string, { fingerprint: string; owner: string; leaseUntil: Date; reservation?: RecipeAuthorReservation; outcome?: RecipeAuthorOutcome }>();
    async claim(i: Parameters<RecipeAuthorReceipts['claim']>[0]): Promise<RecipeAuthorClaim> {
        const doc = this.docs.get(i.key);
        if (!doc) {
            this.docs.set(i.key, { fingerprint: i.fingerprint, owner: i.owner, leaseUntil: i.leaseUntil });
            return { state: 'fresh' };
        }
        if (doc.fingerprint !== i.fingerprint) return { state: 'conflict' };
        if (doc.outcome) return { state: 'done', outcome: doc.outcome };
        if (doc.leaseUntil > i.now) return { state: 'running' };
        Object.assign(doc, { owner: i.owner, leaseUntil: i.leaseUntil });
        return { state: 'taken_over', ...(doc.reservation ? { reservation: doc.reservation } : {}) };
    }
    async reserved(key: string, owner: string, reservation: RecipeAuthorReservation) {
        const doc = this.docs.get(key);
        if (doc?.owner === owner) doc.reservation = reservation;
    }
    async settled(key: string, owner: string) {
        const doc = this.docs.get(key);
        if (doc?.owner === owner) delete doc.reservation;
    }
    async complete(key: string, owner: string, outcome: RecipeAuthorOutcome) {
        const doc = this.docs.get(key);
        if (doc?.owner === owner && !doc.outcome) doc.outcome = outcome;
    }
    async release(key: string, owner: string) {
        if (this.docs.get(key)?.owner === owner && !this.docs.get(key)?.outcome) this.docs.delete(key);
    }
}

describe('POST /internal/runtime/recipe-author asked again for the same attempt', () => {
    const failed = { recipe: GOOD, failure: { signature: 'compose:exit', title: 'the app exited', evidence: ['exit 1'] } };
    /** A runner that waits for `open()` before Kody's run starts, counting the runs. */
    const gated = () => {
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        const real = new AiSdkAgentRunner(undefined);
        const runs = { n: 0 };
        const runners: RuntimeAgentRunnerFactory = {
            forOrganization: async () => ({ runner: { run: async (...a: Parameters<AiSdkAgentRunner['run']>) => (runs.n++, await gate, real.run(...a)) }, model: 'mock-model' }),
        };
        return { runners, open, runs };
    };

    it("after Kody answered, even through another API instance, it returns that answer with no new run and no new budget", async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const receipts = new InMemoryReceipts();
        const usage = new InMemoryLlmUsage();
        const body = { sha: SHA, attempt: 'repair-1', last: failed };
        const first = await make({ receipts, usage }).uc.execute({ authorization: bearer(), body });
        const asked = prompts.length;
        const again = await make({ receipts, usage }).uc.execute({ authorization: bearer(), body });
        expect(again).toEqual(first);
        expect(prompts).toHaveLength(asked);
        expect(usage.rows).toHaveLength(1);
    });

    it('while the same attempt is still being written it answers author_in_progress (409); once written, the answer', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const receipts = new InMemoryReceipts();
        const g = gated();
        const t = make({ receipts, runners: g.runners });
        const running = t.uc.execute({ authorization: bearer(), body: { sha: SHA } });
        while (g.runs.n === 0) await new Promise((r) => setImmediate(r));
        const busy = await t.uc.execute({ authorization: bearer(), body: { sha: SHA } }).catch((e) => e);
        expect(busy.getStatus()).toBe(409);
        expect(busy.getResponse()).toMatchObject({ code: 'author_in_progress' });
        g.open();
        const answer = await running;
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA, attempt: 'author-0' } })).toEqual(answer);
        expect(g.runs.n).toBe(1);
    });

    it('after the API restarted mid-run, asking again runs Kody once more on the budget the lost run reserved', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const receipts = new InMemoryReceipts();
        const usage = new InMemoryLlmUsage();
        let now = NOW;
        // The instance that dies: its run never ends.
        const lost = gated();
        void make({ receipts, usage, runners: lost.runners, now: () => now }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        while (lost.runs.n === 0) await new Promise((r) => setImmediate(r));
        expect(usage.rows).toEqual([expect.objectContaining({ pending: true })]);

        const restarted = () => make({ receipts, usage, now: () => now }).uc.execute({ authorization: bearer(), body: { sha: SHA } });
        await expect(restarted()).rejects.toMatchObject({ response: { code: 'author_in_progress' } });
        now = new Date(NOW.getTime() + RECIPE_AUTHOR_LEASE_MS + 1);
        expect(await restarted()).toMatchObject({ status: 'submitted', recipe: GOOD });
        // One reservation for the attempt, settled by the run that answered.
        expect(usage.rows).toEqual([expect.objectContaining({ pending: false, task: RECIPE_AUTHOR_TASK })]);
    });

    it("a run that failed after reserving answers the same failure when asked again, never a second run on the budget", async () => {
        const runs = { n: 0 };
        const receipts = new InMemoryReceipts();
        const usage = new InMemoryLlmUsage();
        const runners: RuntimeAgentRunnerFactory = { forOrganization: async () => ({ runner: { run: async () => (runs.n++, Promise.reject(new Error('provider down'))) } as any }) };
        for (let i = 0; i < 2; i++) {
            const e = await make({ receipts, usage, runners }).uc.execute({ authorization: bearer(), body: { sha: SHA } }).catch((x) => x);
            expect(e).toBeInstanceOf(HttpException);
            expect(e.getStatus()).toBe(502);
            expect(e.getResponse()).toMatchObject({ code: 'llm_unavailable' });
        }
        expect(runs.n).toBe(1);
        expect(usage.rows).toHaveLength(1);
    });

    it('a refusal that spent nothing is not remembered: asked again once the budget holds a run, Kody writes', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const receipts = new InMemoryReceipts();
        const t = make({ receipts });
        const refused = await t.uc.execute({ authorization: bearer({ maxTokens: 5_000 }), body: { sha: SHA } }).catch((e) => e);
        expect(refused.getStatus()).toBe(429);
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).toMatchObject({ status: 'submitted' });
    });

    it('the same attempt asked with another body is refused as attempt_conflict (409)', async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const t = make({ receipts: new InMemoryReceipts() });
        await t.uc.execute({ authorization: bearer(), body: { sha: SHA, attempt: 'repair-1', last: failed } });
        const e = await t.uc.execute({ authorization: bearer(), body: { sha: SHA, attempt: 'repair-1', last: { ...failed, failure: { ...failed.failure, title: 'another' } } } }).catch((x) => x);
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse()).toMatchObject({ code: 'attempt_conflict' });
    });

    it('a worker that names no attempt still gets a new rewrite for each of its repairs', async () => {
        const rewrite = GOOD.replace('health: /health', 'health: /ready');
        scripted([
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } },
            { tool: SUBMIT_RECIPE_TOOL, input: { recipe: rewrite } },
        ]);
        const t = make({ receipts: new InMemoryReceipts() });
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).toMatchObject({ recipe: GOOD });
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA, last: failed } })).toMatchObject({ status: 'submitted', recipe: rewrite });
    });

    it("a caller that leaves does not stop Kody: the run ends and asking again returns what Kody wrote", async () => {
        scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const real = new AiSdkAgentRunner(undefined);
        const runs = { n: 0 };
        // Like a provider call, the run stops on an aborted signal.
        const runner = {
            run: async (...a: Parameters<AiSdkAgentRunner['run']>) => {
                runs.n++;
                if ((a[2] as { signal?: AbortSignal } | undefined)?.signal?.aborted) throw new Error('aborted');
                return real.run(...a);
            },
        };
        const t = make({ receipts: new InMemoryReceipts(), runners: { forOrganization: async () => ({ runner }) } });
        const gone = new AbortController();
        gone.abort();
        const first = await t.uc.execute({ authorization: bearer(), body: { sha: SHA }, signal: gone.signal });
        expect(first).toMatchObject({ status: 'submitted', recipe: GOOD });
        expect(await t.uc.execute({ authorization: bearer(), body: { sha: SHA } })).toEqual(first);
        expect(runs.n).toBe(1);
    });
});
