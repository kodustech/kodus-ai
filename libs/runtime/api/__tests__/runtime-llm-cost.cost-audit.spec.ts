/**
 * Cost audit of the Kody Runtime's LLM cost, end to end: a Runtime caller runs
 * LLM.run, the usage span it writes is read back by the Runtime's spend read
 * (TokenUsageRepository.getRuntimeUsage through TelemetryRuntimeLlmSpendReader)
 * and priced by the product's price list (PricingResolver). Every layer is the
 * real code except three stand-ins:
 *   - the provider: a scripted AI SDK model (ai/test) that reports usage the way
 *     a provider does (ai@7 shape);
 *   - the span sink: ObservabilityService with its engine replaced by one that
 *     keeps each finished span's attributes, the document the Mongo exporter
 *     stores (timestamp = span start, as the exporter stamps it);
 *   - Mongo: a small evaluator of exactly the aggregation stages the Runtime
 *     read sends ($match, $group, $setWindowFields, $unwind, $replaceRoot,
 *     $project). It throws on any operator it does not know, so it cannot
 *     silently misread a pipeline.
 * Prices are the public catalog entries of models.dev as served on 2026-11-12
 * (google gemini-2.5-pro, fireworks-ai deepseek-v4p1-flash).
 *
 * Tests marked `it.failing` are KNOWN DEFECTS: they state the right behavior
 * and fail today. The plain `it` cases are controls that prove the harness
 * reads and prices a span correctly.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    ...jest.requireActual('@libs/llm/model-invocation'),
    resolveModelConfig: jest.fn(),
}));

import { MockLanguageModelV4 } from 'ai/test';

import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import { TokenPricingUseCase } from '@libs/analytics/application/use-cases/usage/token-pricing.use-case';
import { TOKEN_USAGE_REPOSITORY_TOKEN } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import { TokenUsageRepository } from '@libs/analytics/infrastructure/adapters/repositories/tokenUsage.repository';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { KODUS_DEFAULT_MODEL } from '@libs/llm/byok-defaults';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { getModelName } from '@libs/llm/managed-slot';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { setupLearnScopeId } from '@libs/runtime/run';

import { RuntimeLlmGatewayUseCase } from '../application/use-cases/llm-gateway.use-case';
import { sumLlmSpend } from '../domain/llm-spend';
import { signSetupToken } from '../domain/run-token';
import { buildUsageReport, usageMonthOf } from '../domain/usage-report';
import { ByokRuntimeModelTurnProvider } from '../infrastructure/byok-model-turn.provider';
import { ByokRuntimeAgentRunnerFactory, ByokRuntimeLlmProvider } from '../infrastructure/byok-runtime-llm.provider';
import { TelemetryRuntimeLlmSpendReader } from '../infrastructure/telemetry-llm-spend.reader';
import { clock, config, InMemoryLlmUsage, NOW, ORG, REPO, SECRET, storeWith, TEAM } from './fixtures';

// ── the provider: one scripted request per entry ───────────────────────────
type Request = { input: number; output: number; tool?: string };
let script: Request[] = [];
const scriptedModel = () =>
    new MockLanguageModelV4({
        doGenerate: (async () => {
            const r = script.shift() ?? { input: 0, output: 0 };
            return {
                content: r.tool
                    ? [{ type: 'tool-call', toolCallId: `call-${script.length}`, toolName: r.tool, input: '{}' }]
                    : [{ type: 'text', text: '{"ok":true}' }],
                finishReason: r.tool ? { unified: 'tool-calls', raw: 'tool_use' } : { unified: 'stop', raw: 'stop' },
                usage: {
                    inputTokens: { total: r.input, noCache: r.input, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: r.output, text: r.output, reasoning: 0 },
                },
                warnings: [],
            };
        }) as any,
    });

// ── the span sink: what the Mongo exporter would store, one document per span ──
type SpanDoc = { timestamp: Date; attributes: Record<string, any> };
let stored: SpanDoc[] = [];
let spanClock = new Date('2026-11-10T12:00:00.000Z');
function installSpanSink() {
    const service = new ObservabilityService({ get: jest.fn() } as any); // registers itself as LLM.run's span port
    (service as any).getObsInstance = () => ({
        startSpan: () => {
            const attributes: Record<string, any> = {};
            return { attributes, setAttributes: (a: Record<string, any>) => Object.assign(attributes, a) };
        },
        withSpan: async (span: { attributes: Record<string, any> }, fn: () => Promise<unknown>) => {
            const startedAt = spanClock;
            try {
                return await fn();
            } finally {
                stored.push({ timestamp: startedAt, attributes: JSON.parse(JSON.stringify(span.attributes)) });
            }
        },
        getContext: () => ({ correlationId: 'corr-cost-audit' }),
    });
}

// ── Mongo: the aggregation stages the Runtime read sends ───────────────────
const pathOf = (doc: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
function expr(e: any, doc: any): any {
    if (typeof e === 'string') return e === '$$ROOT' ? doc : e.startsWith('$') ? pathOf(doc, e.slice(1)) : e;
    if (e === null || typeof e !== 'object' || e instanceof Date) return e;
    if (Array.isArray(e)) return e.map((x) => expr(x, doc));
    const keys = Object.keys(e);
    if (keys.length === 1 && keys[0].startsWith('$')) {
        const arg = e[keys[0]];
        switch (keys[0]) {
            case '$literal':
                return arg;
            case '$add':
                return arg.reduce((n: number, x: any) => n + (expr(x, doc) ?? 0), 0);
            case '$cond':
                return expr(arg[0], doc) ? expr(arg[1], doc) : expr(arg[2], doc);
            case '$gt': {
                const [a, b] = arg.map((x: any) => expr(x, doc));
                return a != null && a > b;
            }
            case '$getField':
                return expr(arg.input, doc)?.[arg.field];
            default:
                throw new Error(`mini-mongo: unsupported expression ${keys[0]}`);
        }
    }
    return Object.fromEntries(keys.map((k) => [k, expr(e[k], doc)]));
}
const same = (a: any, b: any) => (a instanceof Date || b instanceof Date ? +a === +b : a === b);
function matches(doc: any, query: Record<string, any>): boolean {
    return Object.entries(query).every(([path, cond]) => {
        const v = pathOf(doc, path);
        const ops = cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).every((k) => k.startsWith('$'));
        if (!ops) return same(v, cond);
        return Object.entries(cond).every(([op, arg]: [string, any]) => {
            switch (op) {
                case '$gte':
                    return v != null && v >= arg;
                case '$lte':
                    return v != null && v <= arg;
                case '$in':
                    return arg.some((a: any) => same(a, v));
                default:
                    throw new Error(`mini-mongo: unsupported query operator ${op}`);
            }
        });
    });
}
function aggregate(docs: any[], pipeline: any[]): any[] {
    let rows = docs;
    for (const stage of pipeline) {
        const [name] = Object.keys(stage);
        const spec = stage[name];
        if (name === '$match') rows = rows.filter((d) => matches(d, spec));
        else if (name === '$group') {
            const { _id, ...acc } = spec;
            const groups = new Map<string, any>();
            for (const d of rows) {
                const id = expr(_id, d);
                const key = JSON.stringify(id);
                let g = groups.get(key);
                if (!g) {
                    g = { _id: id };
                    for (const [f, a] of Object.entries<any>(acc)) g[f] = '$push' in a ? [] : 0;
                    groups.set(key, g);
                }
                for (const [f, a] of Object.entries<any>(acc)) {
                    if ('$push' in a) g[f].push(expr(a.$push, d));
                    else if ('$sum' in a) {
                        const v = typeof a.$sum === 'number' ? a.$sum : expr(a.$sum, d);
                        g[f] += typeof v === 'number' ? v : 0;
                    } else throw new Error(`mini-mongo: unsupported accumulator ${Object.keys(a)[0]}`);
                }
            }
            rows = [...groups.values()];
        } else if (name === '$setWindowFields') {
            const sortKeys = Object.entries<number>(spec.sortBy);
            rows = [...rows].sort((a, b) => {
                for (const [k, dir] of sortKeys) {
                    const x = k === '_id' ? JSON.stringify(a._id) : pathOf(a, k);
                    const y = k === '_id' ? JSON.stringify(b._id) : pathOf(b, k);
                    if (x !== y) return (x < y ? -1 : 1) * dir;
                }
                return 0;
            });
            const out = Object.entries<any>(spec.output);
            const running: Record<string, number> = {};
            rows = rows.map((d) => {
                const next = { ...d };
                for (const [f, def] of out) {
                    if (JSON.stringify(def.window) !== JSON.stringify({ documents: ['unbounded', 'current'] })) throw new Error('mini-mongo: unsupported window');
                    running[f] = (running[f] ?? 0) + (expr(def.$sum, d) ?? 0);
                    next[f] = running[f];
                }
                return next;
            });
        } else if (name === '$unwind') rows = rows.flatMap((d) => (pathOf(d, spec.slice(1)) ?? []).map((el: any) => ({ ...d, [spec.slice(1)]: el })));
        else if (name === '$replaceRoot') rows = rows.map((d) => expr(spec.newRoot, d));
        else if (name === '$project')
            rows = rows.map((d) => {
                const out: any = {};
                for (const [k, v] of Object.entries<any>(spec)) {
                    if (v === 0) continue;
                    const value = v === 1 ? pathOf(d, k) : expr(v, d);
                    if (value !== undefined) out[k] = value;
                }
                return out;
            });
        else throw new Error(`mini-mongo: unsupported stage ${name}`);
    }
    return rows;
}
const telemetryCollection = () => ({
    aggregate: (pipeline: any[]) => ({ option: () => ({ exec: async () => aggregate(structuredClone(stored), pipeline) }) }),
});

// ── the price list: models.dev entries as served on 2026-11-12 ─────────────
const MODELS_DEV = {
    google: {
        id: 'google',
        models: {
            'gemini-2.5-pro': {
                id: 'gemini-2.5-pro',
                cost: { input: 1.25, output: 10, cache_read: 0.125, tiers: [{ input: 2.5, output: 15, cache_read: 0.25, tier: { type: 'context', size: 200_000 } }] },
            },
        },
    },
    'fireworks-ai': {
        id: 'fireworks-ai',
        models: { [KODUS_DEFAULT_MODEL]: { id: KODUS_DEFAULT_MODEL, cost: { input: 0.3, output: 1.2, cache_read: 0.006 } } },
    },
};

/** The Runtime's spend read over the stored spans, priced by the real price list. */
function spendReader() {
    const catalog = new TokenPricingUseCase({ getFromCache: async () => null, addToCache: async () => undefined } as any);
    (catalog as any).fetchJson = async (url: string) => (url.includes('models.dev') ? MODELS_DEV : {});
    const resolver = new PricingResolver(catalog);
    const app = new Map<unknown, unknown>([
        [TOKEN_USAGE_REPOSITORY_TOKEN, new TokenUsageRepository(telemetryCollection() as any, resolver)],
        [PricingResolver, resolver],
    ]);
    return new TelemetryRuntimeLlmSpendReader({
        get: (token: unknown) => {
            if (!app.has(token)) throw new Error('not provided');
            return app.get(token);
        },
    } as any);
}
const NOVEMBER = usageMonthOf('2026-11')!;
const DECEMBER = usageMonthOf('2026-12')!;
const spendOf = (query: { runIds?: string[]; start?: Date; end?: Date } = {}) =>
    spendReader().spendOf({ organizationId: ORG, start: query.start ?? NOVEMBER.start, end: query.end ?? NOVEMBER.end, ...(query.runIds ? { runIds: query.runIds } : {}) });

// ── the Runtime's callers ──────────────────────────────────────────────────
/** A slot as PermissionValidationService.resolveTaskSlot hands it for LLM_TASK.runtime (route stamped). */
const byokSlot = (patch: Record<string, unknown> = {}) =>
    ({ provider: 'google_gemini', model: 'gemini-2.5-pro', apiKey: 'enc:fake-key', route: 'runtime', usedFallback: false, ...patch }) as any;
const slotsGiving = (slot: unknown) => ({ resolveTaskSlot: async () => slot as any });

/** The gateway's provider call (runtime.plan / runtime.intent / runtime.setup_learn). */
const gatewayCall = (slot: unknown, patch: Record<string, unknown> = {}) =>
    new ByokRuntimeLlmProvider(slotsGiving(slot), () => true).complete({
        organizationId: ORG,
        teamId: TEAM,
        runId: 'run-1',
        repositoryId: REPO,
        prNumber: 7,
        task: 'runtime.intent',
        messages: [
            { role: 'system', content: 'Label the finding.' },
            { role: 'user', content: 'finding' },
        ],
        maxOutputTokens: 2_000,
        ...patch,
    });

const readTool: AgentTool = {
    name: 'readFile',
    description: 'read a file',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'file contents' }),
};
/** A harness agent of the Runtime (recipe author; the product's test planner runs the same way). */
async function recipeAuthorRun(slot: unknown, scopeId = 'setup-scope-1') {
    const agent = await new ByokRuntimeAgentRunnerFactory(slotsGiving(slot), () => true).forOrganization(
        { organizationId: ORG, teamId: TEAM },
        { runId: scopeId, task: 'runtime.recipe_author', repositoryId: REPO, environmentId: 'env-1' },
    );
    return agent!.runner.run(
        { id: 'runtime-recipe-author', agentName: 'RuntimeRecipeAuthor', systemPrompt: 'author the recipe', maxSteps: 16, tools: new InMemoryToolRegistry([readTool]), policies: [] },
        { prompt: 'go' },
        { runId: scopeId },
    );
}

/** One worker-hosted planner turn the product executes (runtime.plan.model-turn). */
const modelTurn = (slot: unknown) =>
    new ByokRuntimeModelTurnProvider(slotsGiving(slot), () => true).complete({
        organizationId: ORG,
        teamId: TEAM,
        repositoryId: REPO,
        runId: 'run-1',
        prNumber: 7,
        maxOutputTokens: 2_000,
        request: { call: { prompt: [{ role: 'system', content: 'plan' }, { role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [] } } as any,
        modelCallBudget: { before: async () => ({ maxOutputTokens: 2_000, finish: async () => undefined }) } as any,
    });

beforeEach(() => {
    stored = [];
    script = [];
    spanClock = new Date('2026-11-10T12:00:00.000Z');
    installSpanSink();
    (resolveModelConfig as jest.Mock).mockImplementation((slot: any) => ({
        model: scriptedModel(),
        modelName: slot ? getModelName(slot) : KODUS_DEFAULT_MODEL,
        callOptions: {},
        providerOptions: undefined,
    }));
});
afterEach(() => setLlmObservability(undefined));

describe('control: the harness reads and prices a Runtime span the way the product does', () => {
    it("a BYOK gateway call shows on its Run, priced at the model's base rate, as the org's spend", async () => {
        script = [{ input: 100_000, output: 1_000 }];
        await gatewayCall(byokSlot());

        const rows = await spendOf({ runIds: ['run-1'] });
        const total = sumLlmSpend(rows);
        expect(total.totalTokens).toBe(101_000);
        // 100K × 1.25 + 1K × 10, per million.
        expect(total.usd).toBe(0.135);
        expect(rows).toEqual([expect.objectContaining({ runId: 'run-1', agent: 'intent', paidBy: 'customer', model: 'gemini-2.5-pro' })]);
    });

    it('a single call above 200K input is priced entirely at the long-context tier', async () => {
        script = [{ input: 300_000, output: 1_000 }];
        await gatewayCall(byokSlot());
        // 300K × 2.5 + 1K × 15, per million.
        expect(sumLlmSpend(await spendOf({ runIds: ['run-1'] })).usd).toBe(0.765);
    });
});

describe('L1: a Runtime call on the managed default (no BYOK slot) reaches the Runtime cost', () => {
    // KNOWN DEFECT (cost-audit): tu.route is derived only from slot.route, so a managed-default span has tu.route '' and the Runtime read ('attributes.tu.route' = 'runtime') never sees it.
    it.failing('the gateway call (runtime.intent) on the managed default is on its Run, as Kodus spend', async () => {
        script = [{ input: 50_000, output: 2_000 }];
        await gatewayCall(undefined);

        const rows = await spendOf({ runIds: ['run-1'] });
        expect(sumLlmSpend(rows).totalTokens).toBe(52_000);
        expect(sumLlmSpend(rows).kodusUsd).toBeGreaterThan(0);
    });

    // KNOWN DEFECT (cost-audit): the planner's model turns on the managed default write spans with tu.route '' — absent from the Run page, the usage report and Health.
    it.failing("a worker planner's model turn on the managed default is on its Run", async () => {
        script = [{ input: 40_000, output: 1_500 }];
        await modelTurn(undefined);

        expect(sumLlmSpend(await spendOf({ runIds: ['run-1'] })).totalTokens).toBe(41_500);
    });

    // KNOWN DEFECT (cost-audit): the harness agents stamp route 'runtime' in the span attrs, but tu.route (what the read matches) still comes from the absent slot.
    it.failing("the recipe author on the managed default is in the month's Runtime spend", async () => {
        script = [{ input: 30_000, output: 1_000 }];
        await recipeAuthorRun(undefined);

        expect(sumLlmSpend(await spendOf()).totalTokens).toBe(31_000);
    });
});

describe('L2: the long-context tier is chosen per provider request, not per agent loop', () => {
    // KNOWN DEFECT (cost-audit): LLM.run records one span with the loop's summed usage; the read brackets that sum against 200K, so three 80K requests are billed as one 240K request.
    it.failing('a recipe-author loop of three 80K-token requests on Gemini 2.5 Pro costs three base-rate requests', async () => {
        script = [
            { input: 80_000, output: 1_000, tool: 'readFile' },
            { input: 80_000, output: 1_000, tool: 'readFile' },
            { input: 80_000, output: 1_000 },
        ];
        await recipeAuthorRun(byokSlot());

        const total = sumLlmSpend(await spendOf({ runIds: ['setup-scope-1'] }));
        expect(total.totalTokens).toBe(243_000);
        // Each request: 80K × 1.25 + 1K × 10 per million = 0.11. Today: 240K × 2.5 + 3K × 15 = 0.645.
        expect(total.usd).toBe(0.33);
        expect(total.aboveBaseTierTokens).toBe(0);
    });
});

describe('L3: a model id with capitals is priced at its long-context tier', () => {
    // KNOWN DEFECT (cost-audit): tier thresholds are looked up case-sensitively by tu.model (lowercase catalog keys) while the price lookup lowercases, so 'Gemini-2.5-Pro' above 200K is priced at the base rate.
    it.failing("a 300K-token call of the org's 'Gemini-2.5-Pro' is priced at the 200K+ tier", async () => {
        script = [{ input: 300_000, output: 1_000 }];
        await gatewayCall(byokSlot({ provider: 'google_vertex', model: 'Gemini-2.5-Pro' }));

        // 300K × 2.5 + 1K × 15 per million; today 300K × 1.25 + 1K × 10 = 0.385.
        expect(sumLlmSpend(await spendOf({ runIds: ['run-1'] })).usd).toBe(0.765);
    });
});

describe('L4: a call on a Kodus-funded credential is Kodus spend', () => {
    // KNOWN DEFECT (cost-audit): a `kodus` credential runs on Kodus's own upstream keys, but its span is type 'byok', so it is counted as the org's provider spend and left out of the cost to Kodus.
    it.failing("a call on the org's `kodus` (platform-funded) credential counts in what Kodus pays", async () => {
        script = [{ input: 100_000, output: 2_000 }];
        await gatewayCall(byokSlot({ provider: 'kodus', model: KODUS_DEFAULT_MODEL }));

        const total = sumLlmSpend(await spendOf({ runIds: ['run-1'] }));
        expect(total.totalTokens).toBe(102_000);
        expect(total.customerUsd).toBe(0);
        expect(total.kodusUsd).toBe(total.pricedUsd);
    });
});

describe('L5: each span counts in exactly one month', () => {
    // KNOWN DEFECT (cost-audit): the month is [start, next month's start] with `$lte` on the end, so a span stamped at 00:00:00.000 UTC of the 1st counts in both months.
    it.failing('a call stamped at 2026-12-01T00:00:00.000Z is in December only', async () => {
        spanClock = new Date('2026-12-01T00:00:00.000Z');
        script = [{ input: 10_000, output: 500 }];
        await gatewayCall(byokSlot());

        const november = sumLlmSpend(await spendOf({ start: NOVEMBER.start, end: NOVEMBER.end })).totalTokens;
        const december = sumLlmSpend(await spendOf({ start: DECEMBER.start, end: DECEMBER.end })).totalTokens;
        expect({ november, december }).toEqual({ november: 0, december: 10_500 });
    });
});

describe("L6: the month's spend read keeps every span", () => {
    // KNOWN DEFECT (cost-audit): getRuntimeUsage caps the read at 20 000 buckets (Run × agent × model × tier) and silently drops the lightest; nothing tells the report it is partial.
    it.failing('20 001 Runs with one call each add up to all of their tokens', async () => {
        script = [{ input: 1_000, output: 100 }];
        await gatewayCall(byokSlot());
        const [span] = stored;
        // 20 000 more Runs' calls of the month, the same call on another Run each.
        for (let i = 2; i <= 20_001; i++) stored.push({ ...span, attributes: { ...span.attributes, runId: `run-${i}` } });

        const total = sumLlmSpend(await spendOf());
        expect(total.totalTokens).toBe(20_001 * 1_100);
    }, 120_000);
});

describe("L7: a setup's learn-loop spend is under its environment", () => {
    // KNOWN DEFECT (cost-audit): the gateway passes no environmentId to the provider, so learn-loop spans carry none and the environment filter of the usage report drops them.
    it.failing("the usage report filtered by the setup's environment includes its learn-loop call", async () => {
        const KEY = 'env-1:2026-10-29T12:00:00.000Z';
        spanClock = NOW;
        script = [{ input: 20_000, output: 1_000 }];
        const setups = {
            get: async () => ({
                environmentId: 'env-1',
                organizationId: ORG,
                repositoryId: REPO,
                key: KEY,
                state: 'blocked',
                steps: [],
                blockers: [],
                requestedAt: NOW.toISOString(),
                updatedAt: NOW.toISOString(),
            }),
        };
        const gateway = new RuntimeLlmGatewayUseCase(
            await storeWith(),
            new InMemoryLlmUsage(),
            new ByokRuntimeLlmProvider(slotsGiving(byokSlot()), () => true),
            config(),
            clock,
            undefined,
            setups as any,
        );
        const token = signSetupToken({ setupKey: KEY, environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 3_600 } as any, SECRET);
        await gateway.execute({
            authorization: `Bearer ${token}`,
            body: { runId: setupLearnScopeId(KEY), task: 'runtime.setup_learn', messages: [{ role: 'user', content: '{}' }] },
        });

        const october = usageMonthOf('2026-10')!;
        const spend = await spendReader().spendOf({ organizationId: ORG, start: october.start, end: october.end });
        expect(sumLlmSpend(spend!).totalTokens).toBe(21_000); // the call is in the org's month
        const report = buildUsageReport({
            organizationId: ORG,
            month: october,
            filters: { environmentId: 'env-1' },
            runs: [],
            runsTotal: 0,
            claims: [],
            claimsTruncated: false,
            spend,
            costs: new Map(),
            cellPriceOf: () => null,
            now: NOW,
        });
        expect(report.llm.total?.totalTokens).toBe(21_000);
    });
});
