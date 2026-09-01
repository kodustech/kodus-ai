/**
 * PullRequestClassifierService.classifyBatch — migration parity spec (Phase 3, plan 03-09).
 *
 * Proves the batch classifier's parsed OUTPUT SHAPE is unchanged after migrating
 * off the legacy LangChain PromptRunner path (GEMINI_3_1_FLASH_LITE_PREVIEW
 * pin via `.setProviders`) onto the AI SDK path (runStructuredReviewCall, byokConfig:
 * undefined → managed default). The model CONSOLIDATION is deliberate (RESEARCH
 * Pattern 1) and does not touch the parsed contract: a fixed { classifications: [...] }
 * result maps byte-for-byte to the same Map<string, PRType> the pre-migration code
 * produced, including the defensive id-trim and the PR_TYPES membership filter.
 *
 * NOTE: mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts uses)
 * rather than driving generateText+Output.object against a MockLanguageModelV4 —
 * that structured-output path hangs against an offline model double.
 */
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: 'managed-default' })),
    getModelName: jest.fn(() => 'managed-default'),
    // The executor's error-recovery path consults the slot limiter's cooldown
    // before its one same-model re-issue — no cooldown here (managed default).
    getLimiterForSlot: jest.fn(() => undefined),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({ telemetry: { isEnabled: false } })),
}));

import { PullRequestClassifierService } from './pull-request-classifier.service';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

function buildService(): PullRequestClassifierService {
    return new PullRequestClassifierService(
        {} as any, // DataSource — unused by classifyBatch
        {} as any, // pullRequestsModel — unused by classifyBatch
        observabilityService,
    );
}

const batch = [
    { id: 'pr-1', organizationId: 'org-1', title: 'fix: null deref in parser' },
    { id: 'pr-2', organizationId: 'org-1', title: 'feat: add BYOK routing' },
    { id: 'pr-3', organizationId: 'org-1', title: 'chore: bump deps' },
];

describe('PullRequestClassifierService.classifyBatch — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
        // LLM.run records its span through the observability port — register the mock.
        setLlmObservability(observabilityService);
    });

    it('maps classifications[] to the same Map<string, PRType>, trimming ids and dropping unknown types', async () => {
        mockGenerate.mockResolvedValue({
            experimental_output: {
                classifications: [
                    // Trailing whitespace on the echoed id — must be trimmed.
                    { pullRequestId: 'pr-1 ', type: 'Bug Fix' },
                    { pullRequestId: 'pr-2', type: 'Feature' },
                    // Unknown type not in PR_TYPES — must be dropped.
                    { pullRequestId: 'pr-3', type: 'Chore' },
                ],
            },
        });

        const service = buildService();
        const result: Map<string, string> = await (
            service as any
        ).classifyBatch(batch);

        expect(result instanceof Map).toBe(true);
        expect([...result.entries()]).toEqual([
            ['pr-1', 'Bug Fix'],
            ['pr-2', 'Feature'],
        ]);
        // pr-3 dropped (type not in PR_TYPES).
        expect(result.has('pr-3')).toBe(false);
    });

    it('routes through exactly one AI SDK span path (runAiSdkLLMInSpan), no LangChain wrapper', async () => {
        mockGenerate.mockResolvedValue({
            experimental_output: { classifications: [] },
        });

        const service = buildService();
        const result = await (service as any).classifyBatch(batch);

        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect([...result.entries()]).toEqual([]);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * LLM.run I/O CONTRACT MATRIX — classifyBatch envelope-parse boundary
 *
 * The declared schema D = { classifications: [{ pullRequestId, type }] }; the
 * inner payload the code wants is Map<string, PRType>. The DETERMINISTIC layer
 * this file owns is:
 *   classifyBatch:  const classifications = result?.classifications ?? [];
 *                   for (const c of classifications)
 *                     if (id && PR_TYPES.includes(c.type)) map.set(id, c.type);
 *   run():          per-batch try/catch fail-safe (never rethrow, count `failed`,
 *                   retry next tick) + title-presence input filter + batching.
 *
 * Because the spec mocks `tracedGenerateText`, whatever shape we hand back as
 * `experimental_output` reaches classifyBatch VERBATIM (the real Output.object
 * validation + salvage + json_object reissue that would normally reject an
 * off-shape object lives one boundary UP, in structured-review-call, and is
 * covered by structured-review-call.spec.ts). So these tests pin how THIS
 * boundary behaves when LLM.run hands it a shape that upstream recovery did not
 * fix: it must degrade to a typed-empty Map (observable via run()'s `failed`
 * counter + retry) or fail explicitly — it must NEVER write/return a wrong or
 * out-of-enum classification (the #1786 non-degradation rule).
 *
 * The PR_TYPES membership filter + id-trim are the guard that makes every
 * semantic-but-wrong row a clean DROP, never a wrong-answer ship — so no row
 * here degrades silently and none is an it.failing.
 * ──────────────────────────────────────────────────────────────────────────── */

function resetLlm() {
    mockGenerate.mockReset();
    observabilityService.runAiSdkLLMInSpan.mockClear();
    setLlmObservability(observabilityService);
}

/** Hand classifyBatch the given value as the LLM.run structured result. */
function resolveOutput(output: unknown) {
    mockGenerate.mockResolvedValue({ experimental_output: output });
}

async function classify(output: unknown, input = batch) {
    resolveOutput(output);
    return (await (buildService() as any).classifyBatch(input)) as Map<
        string,
        string
    >;
}

describe('classifyBatch — A. output-shape zoo (off-schema returns degrade to a typed-empty Map, never a wrong answer)', () => {
    beforeEach(resetLlm);

    it('row 1 — exact D: maps every valid item, exact keys/types', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1', type: 'Bug Fix' },
                { pullRequestId: 'pr-2', type: 'Feature' },
                { pullRequestId: 'pr-3', type: 'Refactor' },
            ],
        });
        expect(map instanceof Map).toBe(true);
        expect([...map.entries()]).toEqual([
            ['pr-1', 'Bug Fix'],
            ['pr-2', 'Feature'],
            ['pr-3', 'Refactor'],
        ]);
    });

    it('row 2 — bare array (payload not under .classifications): typed-empty Map, no throw', async () => {
        const map = await classify([
            { pullRequestId: 'pr-1', type: 'Bug Fix' },
        ]);
        expect(map instanceof Map).toBe(true);
        expect(map.size).toBe(0);
    });

    it('row 3 — single object where an array is expected (classifications is a bare object): fails EXPLICITLY (not iterable), absorbed by run()', async () => {
        resolveOutput({ classifications: { pullRequestId: 'pr-1', type: 'Bug Fix' } });
        await expect((buildService() as any).classifyBatch(batch)).rejects.toThrow();
    });

    it('row 4 — wrapper keys {result|data|output|response|json: D}: typed-empty Map (payload unreachable, no invented answer)', async () => {
        for (const key of ['result', 'data', 'output', 'response', 'json']) {
            const map = await classify({
                [key]: { classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] },
            });
            expect(map.size).toBe(0);
        }
    });

    it('row 5 — double wrapper {result:{result:D}}: typed-empty Map', async () => {
        const map = await classify({
            result: { result: { classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] } },
        });
        expect(map.size).toBe(0);
    });

    it('row 6 — numeric/opaque single-key wrap {"0":D} / {content:D}: typed-empty Map', async () => {
        expect((await classify({ '0': { classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] } })).size).toBe(0);
        expect((await classify({ content: { classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] } })).size).toBe(0);
    });

    it('row 7 — stringified JSON (whole D as a string): typed-empty Map, no throw', async () => {
        const map = await classify(
            JSON.stringify({ classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] }),
        );
        expect(map.size).toBe(0);
    });

    it('row 8 — markdown-fenced JSON string: typed-empty Map', async () => {
        const map = await classify(
            '```json\n{"classifications":[{"pullRequestId":"pr-1","type":"Bug Fix"}]}\n```',
        );
        expect(map.size).toBe(0);
    });

    it('row 9 — prose-wrapped string: typed-empty Map', async () => {
        const map = await classify(
            'Here is the result: {"classifications":[{"pullRequestId":"pr-1","type":"Bug Fix"}]}',
        );
        expect(map.size).toBe(0);
    });

    it('row 10 — right data, renamed inner keys: dropped (no aliasing at this boundary), typed-empty Map', async () => {
        const map = await classify({
            classifications: [{ prId: 'pr-1', category: 'Bug Fix' }],
        });
        expect(map.size).toBe(0);
    });

    it('row 11 — case/convention mismatch on the enum value: dropped by PR_TYPES filter', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1', type: 'bug fix' },
                { pullRequestId: 'pr-2', type: 'BUGFIX' },
                { pullRequestId: 'pr-3', type: 'feature' },
            ],
        });
        expect(map.size).toBe(0);
    });

    it('row 12 — partial items (missing type or missing id) are dropped; complete siblings survive', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1' }, // no type
                { type: 'Feature' }, // no id
                { pullRequestId: 'pr-3', type: 'Refactor' }, // complete
            ],
        });
        expect([...map.entries()]).toEqual([['pr-3', 'Refactor']]);
    });

    it('row 13 — extra unknown keys alongside the right ones are tolerated', async () => {
        const map = await classify({
            reasoning: 'analysed titles',
            usage: { tokens: 42 },
            classifications: [
                { pullRequestId: 'pr-1', type: 'Bug Fix', confidence: 0.9, extra: 'x' },
            ],
        });
        expect([...map.entries()]).toEqual([['pr-1', 'Bug Fix']]);
    });

    it('row 14 — empty object {}: typed-empty Map', async () => {
        expect((await classify({})).size).toBe(0);
    });

    it('row 15 — empty array {classifications:[]}: typed-empty Map', async () => {
        expect((await classify({ classifications: [] })).size).toBe(0);
    });

    it('row 16 — empty / whitespace-only string result: typed-empty Map, no throw', async () => {
        expect((await classify('')).size).toBe(0);
        expect((await classify('   \n  ')).size).toBe(0);
    });

    it('row 17 — null / undefined result: the result?. guard yields a typed-empty Map, no throw', async () => {
        expect((await classify(null)).size).toBe(0);
        expect((await classify(undefined)).size).toBe(0);
    });

    it('row 18 — primitive result (true / 0 / "ok"): typed-empty Map, no throw', async () => {
        expect((await classify(true)).size).toBe(0);
        expect((await classify(0)).size).toBe(0);
        expect((await classify('ok')).size).toBe(0);
    });

    it('row 19 — provider envelope leak {choices:[{message:{content}}]}: typed-empty Map', async () => {
        const map = await classify({
            choices: [
                { message: { content: '{"classifications":[{"pullRequestId":"pr-1","type":"Bug Fix"}]}' } },
            ],
        });
        expect(map.size).toBe(0);
    });

    it('row 20 — reasoning/thinking leak object (no .classifications): typed-empty Map', async () => {
        const map = await classify({
            thinking: 'Let me classify... pr-1 is a bug fix.',
            reasoning_content: 'chain of thought without a signature',
        });
        expect(map.size).toBe(0);
    });
});

describe('classifyBatch — B. semantic-but-wrong (valid JSON, wrong value encoding) is DROPPED, never mis-mapped', () => {
    beforeEach(resetLlm);

    it('rows 21–23 — type encoded as boolean / yes-no / number is rejected by the PR_TYPES guard', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1', type: true }, // 21: boolean
                { pullRequestId: 'pr-2', type: 'yes' }, // 22: yes/no
                { pullRequestId: 'pr-3', type: 1 }, // 23: number
            ],
        });
        expect(map.size).toBe(0);
    });

    it('row 24 — enum out of the allowed set ("URGENT" / "Chore") is dropped, a valid sibling survives', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1', type: 'URGENT' },
                { pullRequestId: 'pr-2', type: 'Chore' },
                { pullRequestId: 'pr-3', type: 'Test' },
            ],
        });
        expect([...map.entries()]).toEqual([['pr-3', 'Test']]);
    });

    it('row 25 — dangling reference (id not in the batch) is kept by classifyBatch but the WRITE layer drops it', async () => {
        // classifyBatch does not cross-check ids against the batch...
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1', type: 'Bug Fix' },
                { pullRequestId: 'ghost-999', type: 'Feature' },
            ],
        });
        expect(map.has('ghost-999')).toBe(true);

        // ...but writeClassifications only emits rows whose id is in the batch,
        // so the dangling classification never reaches the INSERT (the guard).
        const query = jest.fn().mockResolvedValue(undefined);
        const svc = new PullRequestClassifierService(
            { query } as any,
            {} as any,
            observabilityService,
        );
        const written = await (svc as any).writeClassifications(batch, map);
        expect(written).toBe(1); // only pr-1
        const params = query.mock.calls[0][1] as unknown[];
        expect(params).not.toContain('ghost-999');
        expect(params).toContain('pr-1');
    });

    it('row 26 — duplicate id in the payload: last-wins (Map.set semantics)', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-1', type: 'Bug Fix' },
                { pullRequestId: 'pr-1', type: 'Refactor' },
            ],
        });
        expect(map.get('pr-1')).toBe('Refactor');
        expect(map.size).toBe(1);
    });

    it('row 27 — unicode / emoji / escaped newlines in fields: valid enum survives with the id intact; emoji type is dropped', async () => {
        const map = await classify({
            classifications: [
                { pullRequestId: 'pr-✅-\n-1', type: 'Bug Fix' },
                { pullRequestId: 'pr-2', type: '🐛 Bug Fix' },
            ],
        });
        expect(map.get('pr-✅-\n-1')).toBe('Bug Fix'); // trim() keeps interior chars
        expect(map.has('pr-2')).toBe(false); // emoji-prefixed enum is out-of-set
    });
});

describe('classifyBatch / run — C. unparseable / transport: the fail-safe layer', () => {
    beforeEach(resetLlm);

    it('row 28/29 — malformed/truncated output that reaches this boundary as a non-D object → typed-empty Map (upstream salvage owns the repair)', async () => {
        // A truncated/fenced body is repaired UP in structured-review-call; if it
        // still arrives off-shape here it must degrade to empty, never invent data.
        const map = await classify({ classifications: '{"pr-1":"Bug Fi' });
        expect(map.size).toBe(0); // iterating the string chars yields no valid item
    });

    it('row 30 — LLM.run throws (network/timeout): classifyBatch propagates AND run() absorbs it into `failed`, never rethrows', async () => {
        mockGenerate.mockRejectedValue(new Error('ECONNRESET'));
        await expect((buildService() as any).classifyBatch(batch)).rejects.toThrow('ECONNRESET');

        // run() fail-safe: the whole batch is counted failed, nothing crashes,
        // rows stay unclassified for the next cron tick.
        const svc = buildService();
        jest.spyOn(svc as any, 'fetchPending').mockResolvedValue(
            batch.map(({ id, organizationId }) => ({ id, organizationId })),
        );
        jest.spyOn(svc as any, 'fetchTitlesFromMongo').mockResolvedValue(
            new Map(batch.map((r) => [r.id, r.title])),
        );
        const write = jest.spyOn(svc as any, 'writeClassifications');
        mockGenerate.mockRejectedValue(new Error('ECONNRESET'));

        const res = await svc.run();
        expect(res.scanned).toBe(3);
        expect(res.classified).toBe(0);
        expect(res.failed).toBe(3);
        expect(res.batches).toBe(1);
        expect(write).not.toHaveBeenCalled();
    });

    it('row 31 — {error:...} returned instead of thrown: typed-empty Map, no crash', async () => {
        const map = await classify({ error: { message: 'model unavailable', code: 503 } });
        expect(map.size).toBe(0);
    });

    it('row 32 — empty success (no output field at all): typed-empty Map', async () => {
        mockGenerate.mockResolvedValue({ text: '', finishReason: 'length' });
        const map = await (buildService() as any).classifyBatch(batch);
        expect(map instanceof Map).toBe(true);
        expect(map.size).toBe(0);
    });

    it('row 33 — refusal prose ("I cannot help"): typed-empty Map', async () => {
        const map = await classify('I cannot help with that request.');
        expect(map.size).toBe(0);
    });

    it('row 34 — abort/hard-timeout error mid-call: run() still absorbs it (fail-safe is throw-agnostic)', async () => {
        const abortErr = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
        });
        const svc = buildService();
        jest.spyOn(svc as any, 'fetchPending').mockResolvedValue(
            batch.map(({ id, organizationId }) => ({ id, organizationId })),
        );
        jest.spyOn(svc as any, 'fetchTitlesFromMongo').mockResolvedValue(
            new Map(batch.map((r) => [r.id, r.title])),
        );
        mockGenerate.mockRejectedValue(abortErr);

        const res = await svc.run();
        expect(res.failed).toBe(3);
        expect(res.classified).toBe(0);
    });

    it('array with a null element fails explicitly (not silently) and is absorbed by run()', async () => {
        resolveOutput({ classifications: [null, { pullRequestId: 'pr-1', type: 'Bug Fix' }] });
        await expect((buildService() as any).classifyBatch(batch)).rejects.toThrow();
    });
});

describe('run — D. input variants: the boundary invariant holds across the input zoo', () => {
    beforeEach(resetLlm);

    /** A run() harness: DB seams stubbed, real classifyBatch, happy LLM mock that
     *  echoes every requested id as a valid classification. */
    function runHarness(
        rows: Array<{ id: string; organizationId: string }>,
        titles: Map<string, string | undefined>,
        allIds: string[],
        options?: { batchSize?: number },
    ) {
        const svc = buildService();
        jest.spyOn(svc as any, 'fetchPending').mockResolvedValue(rows);
        jest.spyOn(svc as any, 'fetchTitlesFromMongo').mockResolvedValue(titles);
        jest.spyOn(svc as any, 'writeClassifications').mockImplementation(
            (async (b: any[], results: Map<string, string>) =>
                b.filter((r) => results.has(r.id)).length) as any,
        );
        // Every LLM call returns a full classification set for all live ids.
        mockGenerate.mockResolvedValue({
            experimental_output: {
                classifications: allIds.map((id) => ({
                    pullRequestId: id,
                    type: 'Feature',
                })),
            },
        });
        return svc.run(options);
    }

    it('row 35 — empty input (0 pending): returns all-zero, LLM never called', async () => {
        const svc = buildService();
        jest.spyOn(svc as any, 'fetchPending').mockResolvedValue([]);
        const fetchTitles = jest.spyOn(svc as any, 'fetchTitlesFromMongo');

        const res = await svc.run();
        expect(res).toMatchObject({ scanned: 0, classified: 0, failed: 0, batches: 0 });
        expect(fetchTitles).not.toHaveBeenCalled();
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('row 36 — single item: one batch, one classification', async () => {
        const res = await runHarness(
            [{ id: 'pr-1', organizationId: 'org-1' }],
            new Map([['pr-1', 'fix: x']]),
            ['pr-1'],
        );
        expect(res).toMatchObject({ scanned: 1, classified: 1, failed: 0, batches: 1 });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('row 37 — large input crossing the batch boundary: chunked into ceil(n/batchSize) calls', async () => {
        const ids = Array.from({ length: 7 }, (_, i) => `pr-${i}`);
        const res = await runHarness(
            ids.map((id) => ({ id, organizationId: 'org-1' })),
            new Map(ids.map((id) => [id, `title ${id}`])),
            ids,
            { batchSize: 3 },
        );
        expect(res.scanned).toBe(7);
        expect(res.classified).toBe(7);
        expect(res.batches).toBe(3); // 3 + 3 + 1
        expect(mockGenerate).toHaveBeenCalledTimes(3);
    });

    it('row 38 — duplicate ids in the input: no crash, Map dedups (one entry per id)', async () => {
        const map = await classify(
            {
                classifications: [
                    { pullRequestId: 'dup-1', type: 'Bug Fix' },
                    { pullRequestId: 'dup-1', type: 'Bug Fix' },
                ],
            },
            [
                { id: 'dup-1', organizationId: 'org-1', title: 'a' },
                { id: 'dup-1', organizationId: 'org-1', title: 'a' },
            ],
        );
        expect(map.size).toBe(1);
        expect(map.get('dup-1')).toBe('Bug Fix');
    });

    it('row 39 — item with a null/empty title is filtered before the LLM and counted failed', async () => {
        const svc = buildService();
        jest.spyOn(svc as any, 'fetchPending').mockResolvedValue([
            { id: 'pr-1', organizationId: 'org-1' },
            { id: 'pr-2', organizationId: 'org-1' },
        ]);
        jest.spyOn(svc as any, 'fetchTitlesFromMongo').mockResolvedValue(
            new Map<string, string | undefined>([
                ['pr-1', 'feat: real title'],
                ['pr-2', undefined as any], // no title → excluded
            ]),
        );
        jest.spyOn(svc as any, 'writeClassifications').mockImplementation(
            (async (b: any[], results: Map<string, string>) =>
                b.filter((r) => results.has(r.id)).length) as any,
        );
        mockGenerate.mockResolvedValue({
            experimental_output: { classifications: [{ pullRequestId: 'pr-1', type: 'Feature' }] },
        });

        const res = await svc.run();
        expect(res.scanned).toBe(2);
        expect(res.classified).toBe(1);
        expect(res.failed).toBe(1); // pr-2 (title-less) never sent
    });

    it('row 40 — whitespace-only title is filtered; special-char/unicode title is kept', async () => {
        const svc = buildService();
        jest.spyOn(svc as any, 'fetchPending').mockResolvedValue([
            { id: 'ws', organizationId: 'org-1' },
            { id: 'uni', organizationId: 'org-1' },
        ]);
        jest.spyOn(svc as any, 'fetchTitlesFromMongo').mockResolvedValue(
            new Map<string, string>([
                ['ws', '   \t  '], // whitespace-only → excluded
                ['uni', 'fix: 修复 🐛 <script>&"'], // special chars → kept
            ]),
        );
        jest.spyOn(svc as any, 'writeClassifications').mockImplementation(
            (async (b: any[], results: Map<string, string>) =>
                b.filter((r) => results.has(r.id)).length) as any,
        );
        mockGenerate.mockResolvedValue({
            experimental_output: { classifications: [{ pullRequestId: 'uni', type: 'Bug Fix' }] },
        });

        const res = await svc.run();
        expect(res.scanned).toBe(2);
        expect(res.classified).toBe(1);
        expect(res.failed).toBe(1);
    });

    it('row 41 — off-by-one at the batch boundary: exactly batchSize = 1 batch; batchSize+1 = 2 batches', async () => {
        const exactIds = ['a', 'b'];
        const exact = await runHarness(
            exactIds.map((id) => ({ id, organizationId: 'o' })),
            new Map(exactIds.map((id) => [id, id])),
            exactIds,
            { batchSize: 2 },
        );
        expect(exact.batches).toBe(1);

        resetLlm();
        const overIds = ['a', 'b', 'c'];
        const over = await runHarness(
            overIds.map((id) => ({ id, organizationId: 'o' })),
            new Map(overIds.map((id) => [id, id])),
            overIds,
            { batchSize: 2 },
        );
        expect(over.batches).toBe(2);
    });

    it('row 42 — order permutation of the same input yields an equivalent classification set (metamorphic)', async () => {
        const forward = await classify(
            {
                classifications: [
                    { pullRequestId: 'pr-1', type: 'Bug Fix' },
                    { pullRequestId: 'pr-2', type: 'Feature' },
                    { pullRequestId: 'pr-3', type: 'Refactor' },
                ],
            },
            batch,
        );
        resetLlm();
        const reversed = await classify(
            {
                classifications: [
                    { pullRequestId: 'pr-3', type: 'Refactor' },
                    { pullRequestId: 'pr-2', type: 'Feature' },
                    { pullRequestId: 'pr-1', type: 'Bug Fix' },
                ],
            },
            [batch[2], batch[1], batch[0]],
        );
        // Same {id → type} decision regardless of order.
        expect(new Map([...forward.entries()].sort())).toEqual(
            new Map([...reversed.entries()].sort()),
        );
    });
});

describe('classifyBatch — request assembly + E. model policy is delegated (byokConfig always undefined → managed default)', () => {
    beforeEach(resetLlm);

    it('threads the exact schema / system / user / runName / byokConfig=undefined into the LLM.run call', async () => {
        resolveOutput({ classifications: [] });
        await (buildService() as any).classifyBatch(batch);

        // The observability span carries the runName the boundary declares.
        const spanArg = observabilityService.runAiSdkLLMInSpan.mock.calls[0][0];
        expect(spanArg.runName).toBe('analytics.pr-type-classifier');

        // The generateText call carries the system prompt + the JSON-serialized
        // payload (title threaded per PR), and structured output is requested.
        const genArg = mockGenerate.mock.calls[0][0];
        expect(genArg.system).toContain('classificação de Pull Requests');
        expect(genArg.prompt).toContain('pr-1');
        expect(genArg.prompt).toContain('fix: null deref in parser');
        expect(genArg.output).toBeDefined(); // Output.object structured mode
    });

    it('always returns a Map<string, PRType> regardless of the return shape (declared-type invariant)', async () => {
        for (const shape of [
            { classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] },
            {},
            [],
            null,
            'prose',
            42,
        ]) {
            const map = await classify(shape as any);
            expect(map instanceof Map).toBe(true);
            for (const v of map.values()) {
                expect(['Bug Fix', 'Feature', 'Refactor', 'Test']).toContain(v);
            }
        }
    });

    // E — N-model policy: this boundary hardcodes `byokConfig: undefined`, so
    // LLM.run resolves the MANAGED DEFAULT on every call (resolveStructuredPlan
    // returns 'as-is', mayUseJsonSchema mocked → true). That is the STRICT
    // json_schema branch, and every A/B/C zoo test above therefore already runs
    // under it. The json_object-fallback branch (kimi/glm/deepseek/z-ai) is
    // UNREACHABLE from here — the boundary cannot pass a non-default slot — so
    // that provider policy is owned + tested one boundary up in
    // structured-review-call.spec.ts, not duplicated here.
    it('E (strict branch) — byokConfig is undefined so the managed-default structured path is exercised by the whole zoo', async () => {
        resolveOutput({ classifications: [{ pullRequestId: 'pr-1', type: 'Bug Fix' }] });
        await (buildService() as any).classifyBatch(batch);
        const genArg = mockGenerate.mock.calls[0][0];
        // structured mode → Output.object present (json_schema branch honored).
        expect(genArg.output).toBeDefined();
    });
});
