// The runner drives the loop through LLM.run, which resolves the model via
// resolveModelConfig: mock it to inject a scripted model (no key, no network).
jest.mock('@libs/llm/model-invocation', () => ({ resolveModelConfig: jest.fn() }));

import { MockLanguageModelV3 } from 'ai/test';

import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';
import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import {
    applyStubs,
    ClearStaleReadsPolicy,
    clearStaleReadsOptions,
    estimateMessagesTokens,
    prefetchContext,
    prefetchOptions,
    RECIPE_AUTHOR_CONTEXT_DEFAULTS,
    readmeRunSections,
    rerunKey,
} from './recipe-author-context';
import { authorRecipe, type RecipeAuthorInput, recipeAuthorTools, type RecipeAuthorWorkspaceRepository, SUBMIT_RECIPE_TOOL } from './recipe-author.agent';
import { READ_LIMITS, type RepoReader } from './repo-reader';

const FAKE_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function memory(files: Record<string, string>, opts: { tree?: boolean } = {}): RepoReader {
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
        read: async (path, max) => (path in files ? files[path].slice(0, max) : null),
        ...(opts.tree ? { paths: async () => Object.keys(files).sort() } : {}),
    };
}

/** A reader with some paths taken out, as the eval's corpus reader hides them: listed nowhere, read as absent. */
function hiding(reader: RepoReader, hide: string[]): RepoReader {
    const hidden = (p: string) => hide.some((h) => p === h || p.startsWith(`${h}/`));
    return {
        list: async (dir) => (await reader.list(dir)).filter((e) => !hidden((dir ? `${dir}/` : '') + e.replace(/\/$/, ''))),
        read: async (path, max) => (hidden(path) ? null : reader.read(path, max)),
    };
}

// ── clearStaleReads ──────────────────────────────────────────────────────────

const big = (tag: string, lines = 200) => Array.from({ length: lines }, (_, i) => `${tag} line ${i} ${'x'.repeat(40)}`).join('\n');

/** A conversation as the runner hands it to a policy: the prompt, then each step's assistant turn and its tool results. */
function conversation(steps: Array<Array<{ id: string; tool: string; input: Record<string, unknown>; output: string }>>, extra: AgentMessage[] = []): AgentMessage[] {
    const out: AgentMessage[] = [{ role: 'user', content: `Repository acme/shop. Facts:\n${big('facts', 30)}` }];
    for (const calls of steps) {
        out.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'reading' }, ...calls.map((c) => ({ type: 'tool-call', toolCallId: c.id, toolName: c.tool, input: c.input }))],
        });
        out.push({
            role: 'tool',
            content: calls.map((c) => ({ type: 'tool-result', toolCallId: c.id, toolName: c.tool, output: { type: 'text', value: c.output } })),
        });
    }
    return [...out, ...extra];
}

const view = (messages: AgentMessage[]): StepView => ({
    runId: 'r1',
    agentId: 'a',
    stepNumber: messages.filter((m) => m.role === 'assistant').length,
    maxSteps: 16,
    steps: [],
    messages,
    activeTools: [],
});

const results = (messages: readonly AgentMessage[]) =>
    messages.flatMap((m) => (m.role === 'tool' && Array.isArray(m.content) ? (m.content as any[]) : [])).map((p) => [p.toolCallId, p.toolName, p.output.value] as const);
const calls = (messages: readonly AgentMessage[]) =>
    messages.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? (m.content as any[]).filter((p) => p.type === 'tool-call') : [])).map((p) => [p.toolCallId, p.toolName] as const);

const FOUR_STEPS = [
    [{ id: 'c1', tool: 'list_files', input: { path: '' }, output: big('root', 60) }],
    [
        { id: 'c2', tool: 'read_file', input: { path: '.github/workflows/ci.yml' }, output: big('ci', 212) },
        { id: 'c3', tool: 'read_file', input: { path: 'missing.txt' }, output: 'ERROR: missing.txt is not in the repository at this commit' },
    ],
    [{ id: 'c4', tool: SUBMIT_RECIPE_TOOL, input: { recipe: 'version: 1' }, output: `ERROR: Refused. Fix and submit again:\n${big('refusal', 20)}` }],
    [{ id: 'c5', tool: 'find_files', input: { glob: '**/Dockerfile*' }, output: big('found', 50) }],
    [{ id: 'c6', tool: 'read_file', input: { path: 'docker-compose.yml' }, output: big('compose', 80) }],
];

describe('clearStaleReads options', () => {
    it('is off unless asked; true takes the defaults; numbers are floored and bounded', () => {
        expect(clearStaleReadsOptions(undefined)).toBeUndefined();
        expect(clearStaleReadsOptions(false)).toBeUndefined();
        expect(clearStaleReadsOptions(true)).toEqual({ afterTokens: 40_000, keepSteps: 2 });
        expect(clearStaleReadsOptions({ keepSteps: 0 })).toEqual({ afterTokens: 40_000, keepSteps: 0 });
        expect(clearStaleReadsOptions({ afterTokens: -5, keepSteps: 1.7 })).toEqual({ afterTokens: 1, keepSteps: 1 });
        expect(prefetchOptions(undefined)).toBeUndefined();
        expect(prefetchOptions(true)).toEqual({ maxChars: RECIPE_AUTHOR_CONTEXT_DEFAULTS.prefetchChars });
        expect(prefetchOptions({ maxChars: 500 })).toEqual({ maxChars: 500 });
    });
});

describe('ClearStaleReadsPolicy', () => {
    it('does nothing below the threshold', () => {
        const state = { pendingChars: 0 };
        const p = new ClearStaleReadsPolicy({ afterTokens: 1_000_000, keepSteps: 2 }, state);
        expect(p.prepareStep(view(conversation(FOUR_STEPS)))).toEqual({});
        expect(p.clearings).toBe(0);
        expect(state.pendingChars).toBe(0);
    });

    it('past the threshold clears every stale read at once, keeps the last steps, and reports before and after', () => {
        const state = { pendingChars: 10_000, rereads: new Set<string>() };
        const p = new ClearStaleReadsPolicy({ afterTokens: 1_000, keepSteps: 2 }, state);
        const messages = conversation(FOUR_STEPS);
        const d = p.prepareStep(view(messages));
        const out = d.messages!;
        const byId = new Map(results(out).map(([id, , v]) => [id, v]));
        expect(byId.get('c1')).toBe('[list_files /: 60 entries, cleared to save context; list it again if you need it]');
        expect(byId.get('c2')).toBe('[read_file .github/workflows/ci.yml: 212 lines, cleared to save context; read it again if you need it]');
        // The last two steps (find_files, then the compose read) stay whole.
        expect(byId.get('c5')).toBe(FOUR_STEPS[3][0].output);
        expect(byId.get('c6')).toBe(FOUR_STEPS[4][0].output);
        const [ev] = d.emit!;
        expect(ev.kind).toBe('context.clear');
        expect(ev.detail).toMatchObject({ cleared: 2, clearing: 1, beforeTokens: estimateMessagesTokens(messages), afterTokens: estimateMessagesTokens(out) });
        expect((ev.detail as any).afterTokens).toBeLessThan((ev.detail as any).beforeTokens);
        expect(p).toMatchObject({ clearings: 1, clearedResults: 2 });
        // What it saved comes off the tool output the stop policy adds to the next step's cost.
        expect(state.pendingChars).toBe(10_000 - ((ev.detail as any).beforeTokens - (ev.detail as any).afterTokens) * 3);
        expect([...state.rereads]).toEqual([rerunKey('list_files', { path: '' }), rerunKey('read_file', { path: '.github/workflows/ci.yml' })]);
    });

    it('never clears the first message, the model\'s own turns, injected notes, submit_recipe results or a short error', () => {
        const note: AgentMessage = { role: 'user', content: `The token budget of this run is almost spent. ${big('note', 30)}` };
        const messages = conversation(FOUR_STEPS, [note]);
        const p = new ClearStaleReadsPolicy({ afterTokens: 1, keepSteps: 0 }, { pendingChars: 0 });
        const out = p.prepareStep(view(messages)).messages!;
        expect(out[0]).toBe(messages[0]);
        expect(out[out.length - 1]).toBe(note);
        out.forEach((m, i) => m.role === 'assistant' && expect(m).toBe(messages[i]));
        const byId = new Map(results(out).map(([id, , v]) => [id, v]));
        expect(byId.get('c3')).toBe(FOUR_STEPS[1][1].output);
        expect(byId.get('c4')).toBe(FOUR_STEPS[2][0].output);
        // keepSteps 0: every read is cleared, the last one too.
        expect(byId.get('c6')).toMatch(/^\[read_file docker-compose.yml: 80 lines, cleared/);
    });

    it('keeps every tool call paired with its result, in place, with its id and tool name', () => {
        const messages = conversation(FOUR_STEPS);
        const out = new ClearStaleReadsPolicy({ afterTokens: 1, keepSteps: 1 }, { pendingChars: 0 }).prepareStep(view(messages)).messages!;
        expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
        expect(calls(out)).toEqual(calls(messages));
        expect(results(out).map(([id, tool]) => [id, tool])).toEqual(calls(messages));
        for (const m of out) if (m.role === 'tool') for (const part of m.content as any[]) expect(part).toMatchObject({ type: 'tool-result', output: { type: 'text' } });
    });

    it('clears in batches: the same stubs every step until the conversation grew by another afterTokens', () => {
        const p = new ClearStaleReadsPolicy({ afterTokens: 3_000, keepSteps: 1 }, { pendingChars: 0 });
        const steps = FOUR_STEPS.slice(0, 2);
        const first = p.prepareStep(view(conversation(steps)));
        expect(p.clearings).toBe(1);
        const after = (first.emit![0].detail as any).afterTokens as number;

        // A small step later: the runner hands the original messages (or the stubbed ones; both seen across AI SDK versions).
        const small = [...steps, [{ id: 'c7', tool: 'read_file', input: { path: 'Makefile' }, output: big('make', 20) }]];
        for (const given of [conversation(small), applyStubs(conversation(small), new Map(results(first.messages!).filter(([, , v]) => v.includes('cleared')).map(([id, , v]) => [id, v])))]) {
            const d = p.prepareStep(view(given));
            expect(d.emit).toBeUndefined();
            expect(p.clearings).toBe(1);
            // The prefix the provider cached is byte for byte the one it saw after the clearing.
            expect(JSON.stringify(d.messages!.slice(0, first.messages!.length))).toBe(JSON.stringify(first.messages));
            expect(estimateMessagesTokens(d.messages!)).toBeLessThan(after + 3_000);
        }

        // Grown past the next threshold: one more batch, of everything stale by then.
        const grown = [...small, [{ id: 'c8', tool: 'read_file', input: { path: 'a.ts' }, output: big('a', 400) }], [{ id: 'c9', tool: 'read_file', input: { path: 'b.ts' }, output: big('b', 400) }]];
        const second = p.prepareStep(view(conversation(grown)));
        expect(p.clearings).toBe(2);
        expect(second.emit![0].detail).toMatchObject({ clearing: 2, cleared: 3 });
        expect(new Map(results(second.messages!).map(([id, , v]) => [id, v])).get('c2')).toMatch(/^\[read_file .github\/workflows\/ci.yml: 212 lines, cleared/);
        const byId = new Map(results(second.messages!).map(([id, , v]) => [id, v]));
        expect(byId.get('c7')).toMatch(/cleared/);
        expect(byId.get('c8')).toMatch(/cleared/);
        expect(byId.get('c9')).toBe(grown[4][0].output);
    });

    it('a cleared read runs once again without spending the read budget', async () => {
        const state = { rejected: [] as string[][], reads: READ_LIMITS.reads, rereads: new Set([rerunKey('read_file', { path: 'package.json' })]) };
        const read = recipeAuthorTools(memory({ 'package.json': '{"name":"x"}' }), state).find((t) => t.name === 'read_file')!;
        expect(await read.execute({ path: 'package.json' }, {} as any)).toEqual({ output: '{"name":"x"}' });
        expect(state.reads).toBe(READ_LIMITS.reads);
        expect(await read.execute({ path: 'package.json' }, {} as any)).toMatchObject({ isError: true, output: expect.stringMatching(/Read budget spent/) });
    });
});

// ── through the runner (the AI SDK validates the pairing on every step) ─────

type Turn = { tool: string; input: unknown };

function scripted(turns: Turn[]) {
    const prompts: any[] = [];
    let i = 0;
    const model = new MockLanguageModelV3({
        doGenerate: (async (options: any) => {
            prompts.push({ prompt: options.prompt, tools: (options.tools ?? []).map((t: any) => t.name) });
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

const GOOD = `version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: app
  expose:
    - { service: app, port: 3000, kind: http }
`;

const SHOP: Record<string, string> = {
    'package.json': `{"name":"shop","packageManager":"pnpm@9.1.0","scripts":{"dev":"node server.js"},"config":{"token":"${FAKE_TOKEN}"}}`,
    'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n${big('lock', 400)}`,
    '.nvmrc': '22\n',
    'docker-compose.yml': 'services:\n  app:\n    build: .\n    ports: ["3000:3000"]\n',
    'docker-compose.dev.yml': 'services:\n  app:\n    command: pnpm dev\n',
    Dockerfile: 'FROM node:22-bookworm\nCOPY . .\nCMD ["node","server.js"]\n',
    '.github/workflows/release.yml': 'name: release\non: push\n',
    '.github/workflows/ci.yml': 'name: ci\non: pull_request\n',
    '.devcontainer/devcontainer.json': '{"image":"node:22"}',
    'README.md': '# Shop\nA shop.\n\n## Features\nMany.\n\n## Getting started\nRun `pnpm dev`.\n\n### With Docker\n`docker compose up`\n\n## License\nMIT\n',
    '.env': `GITHUB_TOKEN=${FAKE_TOKEN}\n`,
    'src/big.ts': big('src', 300),
    'src/other.ts': big('other', 300),
};

const input = (extra: Partial<RecipeAuthorInput> = {}): RecipeAuthorInput => ({ runId: 'r1', repositoryName: 'acme/shop', sha: 'a'.repeat(40), ...extra });
const author = (extra: Partial<RecipeAuthorInput> = {}, files = SHOP) => authorRecipe({ runner: new AiSdkAgentRunner(undefined), reader: memory(files, { tree: true }) }, input(extra));

const READS: Turn[] = [
    { tool: 'read_file', input: { path: 'src/big.ts' } },
    { tool: 'read_file', input: { path: 'src/other.ts' } },
    { tool: 'read_file', input: { path: 'docker-compose.yml' } },
    { tool: 'read_file', input: { path: 'Dockerfile' } },
    { tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } },
];

describe('the options through authorRecipe', () => {
    it('off by default: the prompts, tools and result are byte for byte the same as with no context field', async () => {
        const runs: Array<{ prompts: unknown[]; result: unknown }> = [];
        for (const extra of [{}, { context: {} }, { context: { clearStaleReads: false, prefetch: false } }] as Array<Partial<RecipeAuthorInput>>) {
            const prompts = scripted(READS);
            runs.push({ prompts, result: await author(extra) });
        }
        expect(JSON.stringify(runs[1])).toBe(JSON.stringify(runs[0]));
        expect(JSON.stringify(runs[2])).toBe(JSON.stringify(runs[0]));
        expect(runs[0].result).not.toHaveProperty('context');
        expect(JSON.stringify(runs[0].prompts)).not.toMatch(/Files Kodus read for you|cleared to save context/);
    });

    it('clearStaleReads: the AI SDK takes the cleared conversation, later prompts carry stubs, and the result counts the clearings', async () => {
        const prompts = scripted(READS);
        const r = await author({ context: { clearStaleReads: { afterTokens: 1_500, keepSteps: 1 } } });
        expect(r).toMatchObject({ status: 'submitted', recipe: GOOD, context: { prefetched: [] } });
        expect(r.context!.clearings).toBeGreaterThanOrEqual(1);
        const last = JSON.stringify(prompts[prompts.length - 1].prompt);
        expect(last).toContain('[read_file src/big.ts: 300 lines, cleared to save context; read it again if you need it]');
        expect(last).not.toContain('src line 7 ');
        // The first message (with its Facts) went out unchanged.
        expect(JSON.stringify(prompts[prompts.length - 1].prompt[1])).toBe(JSON.stringify(prompts[0].prompt[1]));
        // Every call the model made has its result in the last request.
        const parts = prompts[prompts.length - 1].prompt.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
        const callIds = parts.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId);
        const resultIds = parts.filter((p: any) => p.type === 'tool-result').map((p: any) => p.toolCallId);
        expect(resultIds).toEqual(callIds);
    });

    it('prefetch: the first message carries the files in order, redacted; the result names them', async () => {
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const r = await author({ context: { prefetch: true } });
        const first = JSON.stringify(prompts[0].prompt);
        expect(first).toContain('Files Kodus read for you before you started');
        expect(first).not.toContain(FAKE_TOKEN);
        expect(r.context).toEqual({
            clearings: 0,
            clearedResults: 0,
            prefetched: [
                'package.json',
                '.nvmrc',
                'pnpm-lock.yaml',
                'docker-compose.dev.yml',
                'docker-compose.yml',
                'Dockerfile',
                '.devcontainer/devcontainer.json',
                '.github/workflows/ci.yml',
                '.github/workflows/release.yml',
                'README.md',
            ],
        });
        // The model's tools and read budget are untouched.
        expect(prompts[0].tools).toEqual(['list_files', 'read_file', 'find_files', SUBMIT_RECIPE_TOOL]);
    });

    it('single mode is untouched by either option', async () => {
        const plain = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const a = await author({ mode: 'single' });
        const opted = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const b = await author({ mode: 'single', context: { prefetch: true, clearStaleReads: { afterTokens: 1 } } });
        expect(JSON.stringify(opted)).toBe(JSON.stringify(plain));
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(b).not.toHaveProperty('context');
    });
});

// ── prefetch ─────────────────────────────────────────────────────────────────

const labels = (text: string) => [...text.matchAll(/^--- (.+?) ---$/gm)].map((m) => m[1]);

describe('prefetchContext', () => {
    it('reads the decisive files in a fixed order, the lockfile header and the README run sections only', async () => {
        const reader = memory(SHOP);
        const { text, files } = await prefetchContext(reader, await reader.list(''), 24_000);
        expect(labels(text)).toEqual([
            'package.json',
            '.nvmrc',
            'pnpm-lock.yaml (first 20 lines)',
            'docker-compose.dev.yml',
            'docker-compose.yml',
            'Dockerfile',
            '.devcontainer/devcontainer.json',
            // CI-like workflows first.
            '.github/workflows/ci.yml',
            '.github/workflows/release.yml',
            'README.md (run sections)',
        ]);
        expect(files).toHaveLength(10);
        expect(text).toContain("lockfileVersion: '9.0'");
        expect(text).not.toContain('lock line 30 ');
        expect(text).toContain('## Getting started\nRun `pnpm dev`.\n\n### With Docker');
        expect(text).not.toContain('## Features');
        expect(text).not.toContain('MIT');
        expect(text).not.toContain('src line');
        // A secret file is never a candidate, and a secret in a manifest is redacted as read_file redacts it.
        expect(text).not.toContain('GITHUB_TOKEN');
        expect(text).not.toContain(FAKE_TOKEN);
        // The same input gives the same block.
        expect((await prefetchContext(reader, await reader.list(''), 24_000)).text).toBe(text);
    });

    it('keeps to the budget: a file that does not fit is cut to what is left, or named as left out', async () => {
        const files = { ...SHOP, Makefile: big('make', 300) };
        const reader = memory(files);
        const { text, files: got } = await prefetchContext(reader, await reader.list(''), 3_000);
        const body = text.slice(text.indexOf('\n\n') + 2, text.lastIndexOf('\n\nLeft out'));
        expect(body.length).toBeLessThanOrEqual(3_000);
        // The Makefile comes after the compose files and the Dockerfile, and is cut to what is left.
        expect(got).toEqual(['package.json', '.nvmrc', 'pnpm-lock.yaml', 'docker-compose.dev.yml', 'docker-compose.yml', 'Dockerfile', 'Makefile']);
        expect(text).toMatch(/--- Makefile ---\n[\s\S]*\[cut at \d+ characters; read_file shows the whole file\]$/m);
        expect(text).toContain(
            'Left out to keep this message small (read them if you need them): .devcontainer/devcontainer.json, .github/workflows/ci.yml, .github/workflows/release.yml, README.md',
        );
        expect((await prefetchContext(reader, await reader.list(''), 0)).text).toBe('');
        // One file is cut at its own cap however large the budget.
        const huge = await prefetchContext(memory({ 'package.json': `{"a":"${'y'.repeat(20_000)}"}` }), ['package.json'], 100_000);
        expect(huge.text).toContain('[cut at 8000 characters; read_file shows the whole file]');
    });

    it('never reads a hidden path, skips missing files and failed reads', async () => {
        const reader = hiding(memory(SHOP), ['docker-compose.dev.yml', '.github', 'README.md']);
        const failing: RepoReader = {
            ...reader,
            read: async (path, max) => {
                if (path === 'Dockerfile') throw new Error('git api down');
                return reader.read(path, max);
            },
        };
        const { files } = await prefetchContext(failing, await failing.list(''), 24_000);
        expect(files).toEqual(['package.json', '.nvmrc', 'pnpm-lock.yaml', 'docker-compose.yml', '.devcontainer/devcontainer.json']);
        expect(await prefetchContext(memory({ 'src/a.ts': 'x' }), ['src/'], 24_000)).toEqual({ text: '', files: [] });
    });

    it('with no root listing, tries the fixed names through the reader (hidden ones read as absent)', async () => {
        const reader = hiding(memory(SHOP), ['Dockerfile']);
        const { files } = await prefetchContext(reader, null, 24_000);
        expect(files).toEqual(['package.json', '.nvmrc', 'pnpm-lock.yaml', 'docker-compose.yml', '.devcontainer/devcontainer.json', '.github/workflows/ci.yml', '.github/workflows/release.yml', 'README.md']);
    });

    it('a workspace adds only each member\'s package manifests, under ../<alias>/', async () => {
        const billing = memory({ 'go.mod': 'module example.com/billing\n\ngo 1.23\n', Dockerfile: 'FROM golang:1.23\n', 'docker-compose.yml': 'services: {}\n' });
        const web = memory({ 'package.json': '{"name":"web"}', 'pyproject.toml': '[project]\nname = "web"\n' });
        const reader = memory(SHOP);
        const { files } = await prefetchContext(reader, await reader.list(''), 24_000, [
            { alias: 'billing', reader: billing },
            { alias: 'web', reader: web },
        ]);
        expect(files.slice(0, 6)).toEqual(['package.json', '.nvmrc', 'pnpm-lock.yaml', '../billing/go.mod', '../web/package.json', '../web/pyproject.toml']);
        expect(files.filter((f) => f.startsWith('../'))).toEqual(['../billing/go.mod', '../web/package.json', '../web/pyproject.toml']);
    });

    it('through authorRecipe, a workspace reads the members by their own readers', async () => {
        const MEMBERS: RecipeAuthorWorkspaceRepository[] = [
            { repositoryId: 'r-shop', fullName: 'acme/shop', alias: 'shop', role: 'primary', sha: 'a'.repeat(40) },
            { repositoryId: 'r-billing', fullName: 'acme/billing', alias: 'billing', role: 'member', sha: 'b'.repeat(40) },
        ];
        const prompts = scripted([{ tool: SUBMIT_RECIPE_TOOL, input: { recipe: GOOD } }]);
        const r = await authorRecipe(
            { runner: new AiSdkAgentRunner(undefined), reader: memory(SHOP, { tree: true }), memberReader: () => memory({ 'go.mod': 'module billing\n' }, { tree: true }) },
            input({ workspace: MEMBERS, context: { prefetch: true } }),
        );
        expect(r.context!.prefetched).toContain('../billing/go.mod');
        expect(JSON.stringify(prompts[0].prompt)).toContain('--- ../billing/go.mod ---\\nmodule billing');
    });
});

describe('readmeRunSections', () => {
    it('takes the running sections down to the next heading of their level, ignoring headings in code fences', () => {
        const md = '# App\nintro\n## Local development\nstep 1\n```sh\n# not a heading\nmake run\n```\n### Database\npg\n## API\nendpoints\n## Docker\ncompose up\n';
        expect(readmeRunSections(md)).toBe('## Local development\nstep 1\n```sh\n# not a heading\nmake run\n```\n### Database\npg\n## Docker\ncompose up');
        expect(readmeRunSections('# App\nNothing about it.\n')).toBeNull();
    });
});
