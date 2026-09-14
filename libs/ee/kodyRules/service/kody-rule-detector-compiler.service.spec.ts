import {
    ruleCompileHash,
    ruleContextNeedHash,
    CONTEXT_NEED_PROMPT_VERSION,
} from '@libs/common/utils/kody-rules/compile-hash';
import { createHash } from 'crypto';
import { KodyRuleDetectorCompilerService } from './kody-rule-detector-compiler.service';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import {
    compilerOutputSchema,
    COMPILER_SYSTEM_PROMPT,
    buildCompilerUserPrompt,
} from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';

// The compiler now runs on the LOCAL (Vercel) stack via runStructuredReviewCall;
// mock it at that boundary (returns the canned compiler JSON).
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));
const mockRun = runStructuredReviewCall as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const org = { organizationId: '11111111-1111-1111-1111-111111111111' } as any;

const make = (compilerOutput: any) => {
    mockRun.mockReset();
    mockRun.mockResolvedValue(compilerOutput);
    const permissionValidationService: any = {
        // native: no carrier → managed/env default (system mode).
        resolveTaskSlot: jest.fn(async () => null),
    };
    const kodyRulesService: any = {
        updateRuleDetector: jest.fn(async () => ({})),
    };
    const svc = new KodyRuleDetectorCompilerService(
        permissionValidationService,
        {} as any, // observabilityService (unused — runStructuredReviewCall mocked)
        kodyRulesService,
    );
    return { svc, kodyRulesService };
};

const mechanicalRule = {
    uuid: 'r1',
    title: 'no console',
    rule: 'do not use console.log',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.info(x)' },
    ],
};

describe('KodyRuleDetectorCompilerService.compileAndSave (#1449 T0)', () => {
    it('persists a detector when the model compiles a passing regex', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        const [, ruleId, detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(ruleId).toBe('r1');
        expect(detector.pattern).toContain('console');
    });

    it('does NOT persist when the model declines (rule stays semantic)', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: false,
            reason: 'needs judgment',
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    it('does NOT persist when the compiled regex fails the gate', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'NEVER_MATCHES', // misses the incorrect example
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    it('clears a stale detector when an edited rule no longer compiles', async () => {
        const { svc, kodyRulesService } = make({ mechanical: false });
        await svc.compileAndSave(org, 'r1', {
            ...mechanicalRule,
            detector: { type: 'regex', pattern: 'old' }, // had one before
        });
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledWith(
            org.organizationId,
            'r1',
            null,
        );
    });

    it('never throws / never persists when the LLM call errors', async () => {
        const { svc, kodyRulesService } = make(null);
        mockRun.mockReset();
        mockRun.mockRejectedValue(new Error('llm down'));
        await expect(
            svc.compileAndSave(org, 'r1', mechanicalRule),
        ).resolves.toEqual({ compiled: false, declineReason: 'error' });
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    // Return contract: callers branch on `compiled`. The tests above assert the
    // persistence side-effect but never the returned verdict, so a mutated
    // return object/boolean survives silently.
    it('returns { compiled: true } on a successful compile', async () => {
        const { svc } = make({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
        });
        const result = await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(result).toEqual({
            compiled: true,
            scoped: false,
            contextNeed: 'diff-only',
        });
    });

    it('returns { compiled: false } and threads the decline reason back out', async () => {
        const { svc } = make({ mechanical: false, reason: 'needs judgment' });
        const result = await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(result.compiled).toBe(false);
        expect(result.declineReason).toBeTruthy();
    });
});

/**
 * Executor input contract: the resolved BYOK slot and the run identifier must
 * reach the shared structured executor. The behaviour tests above mock the
 * executor's RESULT but never inspect its ARGS, so a regression that drops the
 * org's slot (silently falling back to the managed default) or renames the run
 * is invisible to them.
 */
describe('KodyRuleDetectorCompilerService.compileAndSave — executor input', () => {
    const SLOT = { provider: 'openai', apiKey: 'enc', model: 'gpt-4o' };

    const buildWithSlot = (slot: any) => {
        mockRun.mockReset();
        mockRun.mockResolvedValue({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
        });
        const svc = new KodyRuleDetectorCompilerService(
            { resolveTaskSlot: jest.fn(async () => slot) } as any,
            {} as any,
            { updateRuleDetector: jest.fn(async () => ({})) } as any,
        );
        return svc;
    };

    it('passes the resolved slot through to the executor as byokConfig', async () => {
        const svc = buildWithSlot(SLOT);
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(mockRun.mock.calls[0][0].byokConfig).toEqual(SLOT);
    });

    it('sends undefined (managed default) when no slot resolves', async () => {
        const svc = buildWithSlot(null);
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(mockRun.mock.calls[0][0].byokConfig).toBeUndefined();
    });

    it('carries the detector-compiler run identifier to the executor', async () => {
        const svc = buildWithSlot(null);
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        // Robust to which field the executor maps runName onto.
        expect(JSON.stringify(mockRun.mock.calls[0][0])).toContain(
            'kody-rules.detector-compiler',
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKFILL (#1786): close the FULL LLM.run I/O contract matrix at the SERVICE
// boundary. `compileAndSave` is the deterministic wrapper around the LLM.run
// site (kody-rule-detector-compiler.service.ts:71-81): it assembles the request
// (schema / system / user / runName / organizationId / byokConfig), takes the
// model output through `LLM.run` → `runStructuredReviewCall` (mocked here), does
// the blind cast `(parsed as CompilerOutput) ?? null` (service.ts:80), delegates
// to the gate (`compileRuleDetector`), persists via `updateRuleDetector`, and
// guarantees the `{ compiled: boolean; declineReason?: string }` return under a
// try/catch fail-safe (never throws into the fire-and-forget save path).
//
// Declared schema at the model boundary D = CompilerOutput
// {mechanical, pattern?, flags?, reason?}. The strict-json_schema vs json_object
// gate lives UPSTREAM in structured-output-gate (inside runStructuredReviewCall,
// which we mock), so the full A/B/C off-schema zoo is in scope here: the service
// must NEVER persist a wrong detector nor throw past its boundary, and must
// always return its declared shape.
//
// Known silent-degradation sites (#1786 class), pinned as it.failing below:
//   • kody-rule-detector-compiler.service.ts:80  — `(parsed as CompilerOutput)
//     ?? null` blind-casts the model output with no repair/alias/unwrap.
//   • kody-rules-detector.compiler.ts:197 — `if (!out || out.mechanical !== true
//     || !out.pattern)` drops every recoverable off-envelope to 'not-mechanical'.
// ═══════════════════════════════════════════════════════════════════════════

// A valid D payload the strict models emit; json_object-fallback models
// (kimi/glm/deepseek/z-ai) mangle the envelope around it.
const validD = { mechanical: true, pattern: 'console\\.(log|warn|error)\\(' };

// The gate needs the rule's own labeled examples to promote a passing regex.
const gatedRule = {
    uuid: 'r1',
    title: 'no console',
    rule: 'do not use console.log',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.info(x)' },
    ],
};

describe('CONTRACT: request assembly reaches the LLM.run executor (service boundary)', () => {
    it('threads schema, system, user, runName and organizationId into runStructuredReviewCall', async () => {
        const { svc } = make(validD);
        await svc.compileAndSave(org, 'r1', gatedRule);

        const arg = mockRun.mock.calls[0][0];
        // exact declared schema object (identity), so the executor validates
        // against CompilerOutput and never a stale/renamed schema.
        expect(arg.schema).toBe(compilerOutputSchema);
        // the compiler system prompt reaches the model verbatim.
        expect(arg.system).toBe(COMPILER_SYSTEM_PROMPT);
        // the assembled user prompt carries the rule's labeled examples.
        expect(arg.user).toBe(buildCompilerUserPrompt(gatedRule));
        expect(arg.user).toContain('console.log(x)');
        expect(arg.user).toContain('incorrect');
        // run identifier + org tenancy threaded for tracing / routing.
        expect(arg.runName).toBe('kody-rules.detector-compiler');
        expect(arg.organizationId).toBe(org.organizationId);
    });
});

describe('CONTRACT A: output-shape zoo — never persists a wrong detector, always returns declared shape', () => {
    // For every off-schema shape the service must: (a) NOT persist a detector,
    // (b) return { compiled:false, declineReason:<string> }, (c) never throw.
    it.each([
        ['A2 bare array instead of object', [validD]],
        [
            'A3 array where object D expected',
            [{ mechanical: true, pattern: 'x' }],
        ],
        ['A4 {result:D} wrapper', { result: validD }],
        ['A4 {data:D} wrapper', { data: validD }],
        ['A4 {output:D} wrapper', { output: validD }],
        ['A4 {response:D} wrapper', { response: validD }],
        ['A4 {json:D} wrapper', { json: validD }],
        [
            'A5 double {result:{result:D}} wrapper',
            { result: { result: validD } },
        ],
        ['A6 numeric single-key {"0":D} wrap', { 0: validD }],
        ['A6 {content:D} opaque wrap', { content: validD }],
        ['A7 stringified JSON', JSON.stringify(validD)],
        [
            'A8 markdown-fenced JSON',
            '```json\n' + JSON.stringify(validD) + '\n```',
        ],
        [
            'A9 prose-wrapped JSON',
            'Here is the result: ' + JSON.stringify(validD) + '\nLet me know!',
        ],
        [
            'A10 right data under wrong keys',
            { is_mechanical: true, regex: validD.pattern },
        ],
        [
            'A11 case/convention mismatch (Mechanical/Pattern)',
            { Mechanical: true, Pattern: validD.pattern },
        ],
        ['A12 partial object (mechanical, no pattern)', { mechanical: true }],
        [
            'A12 partial object (pattern, no mechanical)',
            { pattern: validD.pattern },
        ],
        ['A14 empty object {}', {}],
        ['A15 empty array []', []],
        ['A16 empty string', ''],
        ['A16 whitespace-only string', '   \n\t '],
        ['A17 null', null],
        ['A17 undefined', undefined],
        ['A18 primitive true', true],
        ['A18 primitive 0', 0],
        ['A18 primitive "ok"', 'ok'],
        [
            'A19 provider envelope leak {choices:[{message:{content}}]}',
            { choices: [{ message: { content: JSON.stringify(validD) } }] },
        ],
        [
            'A20 thinking/reasoning leak block',
            {
                content: [
                    { type: 'thinking', thinking: 'hmm' },
                    { type: 'text', text: JSON.stringify(validD) },
                ],
            },
        ],
    ])(
        'declines %s (no persist, well-formed CompileResult, no throw)',
        async (_label, out) => {
            const { svc, kodyRulesService } = make(out);
            let res: any;
            await expect(
                (async () => {
                    res = await svc.compileAndSave(org, 'r1', gatedRule);
                })(),
            ).resolves.not.toThrow();
            expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
            expect(res.compiled).toBe(false);
            expect(typeof res.declineReason).toBe('string');
        },
    );

    it('A1 happy path — exact D persists the detector and returns { compiled:true }', async () => {
        const { svc, kodyRulesService } = make(validD);
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        const [, , detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(detector.pattern).toBe(validD.pattern);
        expect(res).toEqual({
            compiled: true,
            scoped: false,
            contextNeed: 'diff-only',
        });
    });

    it('A13 tolerates extra unknown keys alongside the right ones (persists, no crash)', async () => {
        const { svc, kodyRulesService } = make({
            ...validD,
            flags: 'i',
            reason: 'no console',
            foo: 'bar',
            nested: { a: 1 },
        });
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        expect(res).toEqual({
            compiled: true,
            scoped: false,
            contextNeed: 'diff-only',
        });
    });

    it('A17 a null model output on an edited rule CLEARS the stale detector (no silent keep)', async () => {
        const { svc, kodyRulesService } = make(null);
        await svc.compileAndSave(org, 'r1', {
            ...gatedRule,
            detector: { type: 'regex', pattern: 'old' },
        });
        // #1786 invariant: an unparseable/empty output must not leave a stale
        // detector shipping silently — the boundary observably clears it.
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledWith(
            org.organizationId,
            'r1',
            null,
        );
    });
});

describe('CONTRACT A: recoverable payloads the service silently drops (#1786 known degradations)', () => {
    // Each carries the real, valid D. The NON-DEGRADING behavior is to recover it
    // and persist the detector. Today service.ts:80 blind-casts and the gate
    // guard (compiler.ts:197) drops these to 'not-mechanical'. it.failing: green
    // now, flips red the day the repair path lands at either site.
    it.failing('A4 recovers {result:D} and persists', async () => {
        const { svc, kodyRulesService } = make({ result: validD });
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ compiled: true, scoped: false });
    });
    it.failing('A7 repairs a stringified-JSON envelope and persists', async () => {
        const { svc, kodyRulesService } = make(JSON.stringify(validD));
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ compiled: true, scoped: false });
    });
    it.failing('A8 repairs markdown-fenced JSON and persists', async () => {
        const { svc, kodyRulesService } = make(
            '```json\n' + JSON.stringify(validD) + '\n```',
        );
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ compiled: true, scoped: false });
    });
    it.failing(
        'A11 aliases case/convention-mismatched keys and persists',
        async () => {
            const { svc, kodyRulesService } = make({
                Mechanical: true,
                Pattern: validD.pattern,
            });
            const res = await svc.compileAndSave(org, 'r1', gatedRule);
            expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(
                1,
            );
            expect(res).toEqual({ compiled: true, scoped: false });
        },
    );
    it.failing(
        'signals an unparseable envelope distinctly, not as a genuine not-mechanical decision',
        async () => {
            // A garbage object must not masquerade as "the model judged this rule
            // non-mechanical" — that decline reason is the only downstream signal.
            const { svc } = make({ foo: 'bar' });
            const res = await svc.compileAndSave(org, 'r1', gatedRule);
            expect(res.declineReason).not.toBe('not-mechanical');
        },
    );
});

describe('CONTRACT B: semantic-but-wrong value encodings', () => {
    it('B21 boolean-as-string mechanical:"true" declines safely (observable, no persist)', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: 'true',
            pattern: validD.pattern,
        });
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
        expect(typeof res.declineReason).toBe('string');
    });
    it('B22 boolean-as-yes/no mechanical:"yes" declines safely', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: 'yes',
            pattern: validD.pattern,
        });
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('B23 boolean-as-number mechanical:1 declines safely', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: 1,
            pattern: validD.pattern,
        });
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it.failing(
        'B21 coerces mechanical:"true" to true and persists (#1786)',
        async () => {
            const { svc, kodyRulesService } = make({
                mechanical: 'true',
                pattern: validD.pattern,
            });
            await svc.compileAndSave(org, 'r1', gatedRule);
            expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(
                1,
            );
        },
    );
    it('B26 stringified body with duplicate keys is not trusted as an object (fail-safe)', async () => {
        // The service receives a raw string, not a parsed object; JSON.parse
        // last-wins semantics never get a chance to promote a wrong detector.
        const { svc, kodyRulesService } = make(
            '{"mechanical":false,"mechanical":true,"pattern":"' +
                validD.pattern.replace(/\\/g, '\\\\') +
                '"}',
        );
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('B27 preserves unicode/emoji/escaped content in the persisted detector', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: validD.pattern,
            reason: 'no console 🚫 — véfïçá \\n newline',
        });
        await svc.compileAndSave(org, 'r1', gatedRule);
        const [, , detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(detector.reason).toBe('no console 🚫 — véfïçá \\n newline');
    });
});

describe('CONTRACT C: unparseable / transport — the fail-safe layer', () => {
    it('C28 truncated JSON body declines (documented fallback, no crash)', async () => {
        const { svc, kodyRulesService } = make(
            '{"mechanical":true,"pattern":"con',
        );
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('C29 malformed JSON body (trailing comma / unquoted keys) declines', async () => {
        const { svc, kodyRulesService } = make(
            '{mechanical: true, pattern: "x",}',
        );
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('C30 LLM.run rejects (network/timeout) — fails safe to declineReason:"error", never throws, never persists', async () => {
        const { svc, kodyRulesService } = make(null);
        mockRun.mockReset();
        mockRun.mockRejectedValue(
            new Error('provider 500 / suspended BYOK key'),
        );
        await expect(svc.compileAndSave(org, 'r1', gatedRule)).resolves.toEqual(
            { compiled: false, declineReason: 'error' },
        );
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });
    it('C31 an error-object return {error:...} is not trusted (declines, no persist)', async () => {
        const { svc, kodyRulesService } = make({
            error: 'rate limited',
            code: 429,
        });
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('C32 empty-success return declines', async () => {
        const { svc, kodyRulesService } = make('');
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('C33 refusal prose return ("I cannot help…") declines', async () => {
        const { svc, kodyRulesService } = make(
            "I'm sorry, but I can't help with that request.",
        );
        const res = await svc.compileAndSave(org, 'r1', gatedRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
    });
    it('C34 an aborted call fails safe (declineReason:"error") rather than throwing past the boundary', async () => {
        // Unlike the pure gate (which rethrows), the SERVICE wraps the whole call
        // in try/catch, so an AbortError is absorbed into the documented fallback.
        const { svc, kodyRulesService } = make(null);
        mockRun.mockReset();
        mockRun.mockImplementation(async () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            throw e;
        });
        await expect(svc.compileAndSave(org, 'r1', gatedRule)).resolves.toEqual(
            { compiled: false, declineReason: 'error' },
        );
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });
});

describe('CONTRACT D: input variants into the service boundary', () => {
    it('D35 empty examples declines (no-usable-examples), no persist, no crash', async () => {
        const { svc, kodyRulesService } = make(validD);
        const res = await svc.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: [],
        });
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res).toEqual({
            compiled: false,
            declineReason: 'no-usable-examples',
            contextNeed: 'diff-only',
        });
    });
    it('D36 a single incorrect example is enough to gate + persist', async () => {
        const { svc, kodyRulesService } = make(validD);
        const res = await svc.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: [{ isCorrect: false, snippet: 'console.log(x)' }],
        });
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        expect(res).toEqual({
            compiled: true,
            scoped: false,
            contextNeed: 'diff-only',
        });
    });
    it('D38 duplicate examples do not change the compile decision (idempotent)', async () => {
        const { svc, kodyRulesService } = make(validD);
        const res = await svc.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: [
                { isCorrect: false, snippet: 'console.log(x)' },
                { isCorrect: false, snippet: 'console.log(x)' },
                { isCorrect: true, snippet: 'logger.info(x)' },
                { isCorrect: true, snippet: 'logger.info(x)' },
            ],
        });
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        expect(res).toEqual({
            compiled: true,
            scoped: false,
            contextNeed: 'diff-only',
        });
    });
    it('D39 a null example entry fails safe (no throw past boundary, no persist)', async () => {
        // buildCompilerUserPrompt (compiler.ts:74, `ex.isCorrect`) crashes on a
        // null entry during prompt assembly, BEFORE the gate's own null-filter can
        // run. The service must absorb it into the documented fallback, never
        // throw into the fire-and-forget save path.
        const { svc, kodyRulesService } = make(validD);
        let res: any;
        await expect(
            (async () => {
                res = await svc.compileAndSave(org, 'r1', {
                    ...gatedRule,
                    examples: [
                        null,
                        { isCorrect: false, snippet: null },
                        { isCorrect: false, snippet: 'console.log(x)' },
                        { isCorrect: true, snippet: 'logger.info(x)' },
                    ],
                } as any);
            })(),
        ).resolves.not.toThrow();
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res.compiled).toBe(false);
        expect(typeof res.declineReason).toBe('string');
    });
    it.failing(
        'D39 KNOWN DEGRADATION: a null example entry should be filtered and the valid rule promoted (compiler.ts:74)',
        async () => {
            // The correct non-degrading behavior: null/garbage entries are dropped
            // (as the gate already does) and the remaining labeled examples gate a
            // passing regex. Prompt assembly should tolerate the same shapes the
            // gate does. Green today (crashes to 'error'), red once :74 hardens.
            const { svc, kodyRulesService } = make(validD);
            const res = await svc.compileAndSave(org, 'r1', {
                ...gatedRule,
                examples: [
                    null,
                    { isCorrect: false, snippet: null },
                    { isCorrect: false, snippet: 'console.log(x)' },
                    { isCorrect: true, snippet: 'logger.info(x)' },
                ],
            } as any);
            expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(
                1,
            );
            expect(res).toEqual({ compiled: true, scoped: false });
        },
    );
    it('D39 undefined examples array is treated as no labeled signal, not a crash', async () => {
        const { svc, kodyRulesService } = make(validD);
        const res = await svc.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: undefined,
        });
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(res).toEqual({
            compiled: false,
            declineReason: 'no-usable-examples',
            contextNeed: 'diff-only',
        });
    });
    it('D40 a pattern with special/unicode chars still persists and round-trips', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'café',
        });
        const res = await svc.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: [
                { isCorrect: false, snippet: 'const café = "😀"' },
                { isCorrect: true, snippet: 'const tea = 1' },
            ],
        });
        expect(res).toEqual({
            compiled: true,
            scoped: false,
            contextNeed: 'diff-only',
        });
        const [, , detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(detector.pattern).toBe('café');
    });
    it('D42 example order does not change the compile decision (metamorphic)', async () => {
        const { svc: svcA } = make(validD);
        const forward = await svcA.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: [
                { isCorrect: false, snippet: 'console.log(x)' },
                { isCorrect: true, snippet: 'logger.info(x)' },
            ],
        });
        const { svc: svcB } = make(validD);
        const reversed = await svcB.compileAndSave(org, 'r1', {
            ...gatedRule,
            examples: [
                { isCorrect: true, snippet: 'logger.info(x)' },
                { isCorrect: false, snippet: 'console.log(x)' },
            ],
        });
        expect(forward).toEqual(reversed);
    });
});

describe('CONTRACT E: N-model policy — service is model-agnostic (gate lives upstream)', () => {
    // structured-output-gate decides strict-json_schema (openai/anthropic/google/
    // moonshotai → trusts clean D) vs json_object fallback (kimi/glm/deepseek/
    // z-ai → full zoo) INSIDE runStructuredReviewCall, which we mock. The service
    // itself never branches on model: it always passes `schema: compilerOutputSchema`
    // and marks `compiledBy` with 'byok' (a resolved slot) or 'system' (managed
    // default). So the off-schema defense must be identical whichever model ran,
    // and the model marker must round-trip onto the persisted detector.
    const buildSvc = (slot: any, out: any) => {
        mockRun.mockReset();
        mockRun.mockResolvedValue(out);
        const kodyRulesService: any = {
            updateRuleDetector: jest.fn(async () => ({})),
        };
        const svc = new KodyRuleDetectorCompilerService(
            { resolveTaskSlot: jest.fn(async () => slot) } as any,
            {} as any,
            kodyRulesService,
        );
        return { svc, kodyRulesService };
    };
    const SLOT = { provider: 'openai', apiKey: 'enc', model: 'gpt-4o' };

    it.each([
        ['strict-json_schema model (resolved BYOK slot)', SLOT],
        ['json_object-fallback model (managed default)', null],
    ])(
        'an off-schema {result:D} envelope declines identically under a %s',
        async (_label, slot) => {
            const { svc, kodyRulesService } = buildSvc(slot, {
                result: validD,
            });
            const res = await svc.compileAndSave(org, 'r1', gatedRule);
            expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
            expect(res.compiled).toBe(false);
            expect(typeof res.declineReason).toBe('string');
        },
    );

    it('always passes the exact compilerOutputSchema regardless of the resolved model', async () => {
        const { svc: sByok } = buildSvc(SLOT, validD);
        await sByok.compileAndSave(org, 'r1', gatedRule);
        expect(mockRun.mock.calls[0][0].schema).toBe(compilerOutputSchema);

        const { svc: sSystem } = buildSvc(null, validD);
        await sSystem.compileAndSave(org, 'r1', gatedRule);
        expect(mockRun.mock.calls[0][0].schema).toBe(compilerOutputSchema);
    });

    it('a resolved BYOK slot marks the persisted detector compiledBy:"byok"', async () => {
        const { svc, kodyRulesService } = buildSvc(SLOT, validD);
        await svc.compileAndSave(org, 'r1', gatedRule);
        const [, , detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(detector.compiledBy).toBe('byok');
    });

    it('the managed default marks the persisted detector compiledBy:"system"', async () => {
        const { svc, kodyRulesService } = buildSvc(null, validD);
        await svc.compileAndSave(org, 'r1', gatedRule);
        const [, , detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(detector.compiledBy).toBe('system');
    });
});

// ── #1826: the same compile call also decides what the rule must SEE ────────
// Derived from spec.md's P2 story:
//   KRC-10  the rule stores a contextNeed, inferred once at save time
//   KRC-12  the inference is invalidated by the rule-text hash
//   KRC-17  diff-only stays the value whenever the compiler is not confident
// The "one call" part is a requirement, not an optimization: a second round
// trip per rule save would double the authoring cost of every rule.
describe('KodyRuleDetectorCompilerService — context-need inference (#1826)', () => {
    const needRule = {
        uuid: 'r1',
        title: 'no unused imports',
        rule: 'Remove imports that are not used in the file.',
        examples: [
            { isCorrect: false, snippet: 'console.log(x)' },
            { isCorrect: true, snippet: 'logger.info(x)' },
        ],
    };

    const makeWithNeed = (compilerOutput: any) => {
        mockRun.mockReset();
        mockRun.mockResolvedValue(compilerOutput);
        const kodyRulesService: any = {
            updateRuleDetector: jest.fn(async () => ({})),
            updateRuleContextNeed: jest.fn(async () => ({})),
        };
        const svc = new KodyRuleDetectorCompilerService(
            { resolveTaskSlot: jest.fn(async () => null) } as any,
            {} as any,
            kodyRulesService,
        );
        return { svc, kodyRulesService };
    };

    const storedNeed = (kodyRulesService: any) =>
        kodyRulesService.updateRuleContextNeed.mock.calls[0][2];

    it('stores the need the compile call returned, in the same round trip', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            contextNeed: 'symbol-references',
            reason: 'needs the repository',
        });

        const res = await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);

        // one LLM call for BOTH decisions — no second round trip
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(kodyRulesService.updateRuleContextNeed).toHaveBeenCalledTimes(1);
        expect(storedNeed(kodyRulesService).need).toBe('symbol-references');
        expect(res.contextNeed).toBe('symbol-references');
    });

    it('asks the model for the need in the same prompt that asks for the detector', async () => {
        const { svc } = makeWithNeed({ mechanical: false });
        await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);
        expect(mockRun.mock.calls[0][0].system).toContain('"contextNeed"');
        expect(mockRun.mock.calls[0][0].system).toContain('symbol-references');
    });

    it('stores diff-only when the model omits the need (KRC-17)', async () => {
        const { svc, kodyRulesService } = makeWithNeed({ mechanical: false });
        await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);
        expect(storedNeed(kodyRulesService).need).toBe('diff-only');
    });

    it('stores diff-only when the model invents a need outside the vocabulary', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            // Also covers 'enclosing-scope', which issue #1826 step 1 removed
            // from the vocabulary: the file shard carries the whole file, so a
            // need for "the scope around the change" no longer exists.
            contextNeed: 'the-whole-repository',
        });
        await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);
        expect(storedNeed(kodyRulesService).need).toBe('diff-only');
    });

    it('stores the need for a MECHANICAL rule too', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
            contextNeed: 'sibling-file',
        });
        await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);
        expect(storedNeed(kodyRulesService).need).toBe('sibling-file');
    });

    it('stamps the need with the hash of the rule text it was inferred from (KRC-12)', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            contextNeed: 'sibling-file',
        });
        await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);

        const written = storedNeed(kodyRulesService);
        expect(written.sourceHash).toBe(
            ruleContextNeedHash({ rule: needRule.rule }),
        );
        expect(written.source).toBe('compiler');
        expect(written.inferredAt).toBeInstanceOf(Date);
        expect(written.model).toBe('system');
    });

    it('does not rewrite an unchanged need for unchanged rule text (idempotent)', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            contextNeed: 'sibling-file',
        });
        const res = await svc.compileAndSave(
            { organizationId: 'org-1' } as any,
            'r1',
            {
                ...needRule,
                contextNeed: {
                    need: 'sibling-file',
                    sourceHash: ruleContextNeedHash({ rule: needRule.rule }),
                    source: 'compiler',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            } as any,
        );
        expect(kodyRulesService.updateRuleContextNeed).not.toHaveBeenCalled();
        expect(res.contextNeed).toBe('sibling-file');
    });

    it('reuses the stored need for unchanged rule text even when this run infers a different one (KRC-12)', async () => {
        // The hash is the SOLE trigger for re-inference. Keying on the verdict
        // instead let a second run overwrite a settled need on a rule nobody
        // edited, so the same text could flip between reviews and take the
        // customer's rule in and out of scope with no author action.
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            contextNeed: 'symbol-references',
        });
        const res = await svc.compileAndSave(
            { organizationId: 'org-1' } as any,
            'r1',
            {
                ...needRule,
                contextNeed: {
                    need: 'sibling-file',
                    sourceHash: ruleContextNeedHash({ rule: needRule.rule }),
                    source: 'compiler',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            } as any,
        );
        expect(kodyRulesService.updateRuleContextNeed).not.toHaveBeenCalled();
        expect(res.contextNeed).toBe('sibling-file');
    });

    it('re-infers when the stored hash no longer matches the rule text (KRC-12)', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            contextNeed: 'symbol-references',
        });
        await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', {
            ...needRule,
            contextNeed: {
                need: 'sibling-file',
                sourceHash: 'hash-of-the-OLD-text',
                source: 'compiler',
                inferredAt: new Date('2026-01-01T00:00:00Z'),
            },
        } as any);
        expect(storedNeed(kodyRulesService).need).toBe('symbol-references');
    });

    it('never overwrites an author-set need', async () => {
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: false,
            contextNeed: 'symbol-references',
        });
        const res = await svc.compileAndSave(
            { organizationId: 'org-1' } as any,
            'r1',
            {
                ...needRule,
                contextNeed: {
                    need: 'enclosing-scope',
                    sourceHash: 'anything',
                    source: 'author',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            } as any,
        );
        expect(kodyRulesService.updateRuleContextNeed).not.toHaveBeenCalled();
        expect(res.contextNeed).toBe('enclosing-scope');
    });

    it('still reports the detector outcome when storing the need fails', async () => {
        // Fire-and-forget path: a failed need write must not turn a compiled
        // detector into a failed compile.
        const { svc, kodyRulesService } = makeWithNeed({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
            contextNeed: 'diff-only',
        });
        kodyRulesService.updateRuleContextNeed.mockRejectedValue(
            new Error('mongo down'),
        );

        const res = await svc.compileAndSave({ organizationId: 'org-1' } as any, 'r1', needRule);

        expect(res.compiled).toBe(true);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
    });
});

// ── the rule's own language scope, saved for EVERY rule (#1826, step 1b) ────
//
// The scope used to be written only as part of a surviving detector, so the
// 92,5% of the fleet with no detector had nowhere to record it and were judged
// against every file in the PR regardless of the language the rule names.
describe('KodyRuleDetectorCompilerService — rule-level file scope (#1826)', () => {
    const rubyRule = {
        uuid: 'r1',
        title: 'Ruby keyword args',
        rule: 'In Ruby, prefer keyword arguments over positional ones.',
    };

    const makeWithScope = (compilerOutput: any) => {
        mockRun.mockReset();
        mockRun.mockResolvedValue(compilerOutput);
        const kodyRulesService: any = {
            updateRuleDetector: jest.fn(async () => ({})),
            updateRuleContextNeed: jest.fn(async () => ({})),
            updateRuleFileScope: jest.fn(async () => ({})),
        };
        const svc = new KodyRuleDetectorCompilerService(
            { resolveTaskSlot: jest.fn(async () => null) } as any,
            {} as any,
            kodyRulesService,
        );
        return { svc, kodyRulesService };
    };

    const storedScope = (k: any) => k.updateRuleFileScope.mock.calls[0][2];

    it('saves the scope for a SEMANTIC rule — the case the detector path never covered', async () => {
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: false,
            extensions: ['.rb', '.rake'],
            reason: 'needs judgment',
        });
        const res = await svc.compileAndSave(org, 'r1', rubyRule);

        expect(res.compiled).toBe(false);
        expect(kodyRulesService.updateRuleFileScope).toHaveBeenCalledTimes(1);
        expect(storedScope(kodyRulesService)).toMatchObject({
            extensions: ['.rb', '.rake'],
            source: 'compiler',
        });
        expect(res.fileScope).toEqual(['.rb', '.rake']);
    });

    it('normalizes what the model answered (bare, upper-case, prompt brackets)', async () => {
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: false,
            extensions: ['RB', '<.erb>', 'app/models/', '*.rake'],
        });
        await svc.compileAndSave(org, 'r1', rubyRule);
        // Bare and upper-case are normalized; the stray prompt-template
        // brackets are stripped; globs and paths are dropped entirely because
        // they are not extensions.
        expect(storedScope(kodyRulesService).extensions).toEqual([
            '.rb',
            '.erb',
        ]);
    });

    it('writes NOTHING for a language-agnostic rule instead of an empty list', async () => {
        // An empty list would read as "applies to no file kind" — the opposite
        // of what an unscoped rule means.
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: false,
            reason: 'agnostic',
        });
        const res = await svc.compileAndSave(org, 'r1', {
            uuid: 'r1',
            title: 'no secrets',
            rule: 'Never hardcode credentials.',
        });
        expect(kodyRulesService.updateRuleFileScope).not.toHaveBeenCalled();
        expect(res.fileScope).toBeUndefined();
    });

    it('CLEARS a stored scope when the edited rule no longer names a language', async () => {
        // Otherwise the rule keeps a narrowing nobody can see and silently
        // stops being enforced on the files it now covers.
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: false,
            reason: 'agnostic now',
        });
        await svc.compileAndSave(org, 'r1', {
            ...rubyRule,
            rule: 'Never hardcode credentials.',
            fileScope: {
                extensions: ['.rb'],
                sourceHash: 'stale-hash',
                source: 'compiler',
                inferredAt: new Date(),
            },
        } as any);
        expect(kodyRulesService.updateRuleFileScope).toHaveBeenCalledTimes(1);
        expect(storedScope(kodyRulesService)).toBeNull();
    });

    it('does not re-write when the rule text is unchanged (hash gate)', async () => {
        // fileScope keeps the plain text hash — only the CONTEXT NEED is
        // versioned by the classifier prompt.
        const sourceHash = createHash('sha256')
            .update(rubyRule.rule)
            .digest('hex');
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: false,
            extensions: ['.py'], // a differently-inferred second run
        });
        const res = await svc.compileAndSave(org, 'r1', {
            ...rubyRule,
            fileScope: {
                extensions: ['.rb'],
                sourceHash,
                source: 'compiler',
                inferredAt: new Date(),
            },
        } as any);
        // The hash is the SOLE trigger for re-inference. Without this, two runs
        // over the same unedited text would flip the rule in and out of
        // enforcement between reviews with no author action.
        expect(kodyRulesService.updateRuleFileScope).not.toHaveBeenCalled();
        expect(res.fileScope).toEqual(['.rb']);
    });

    it('never overwrites an author-set scope', async () => {
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: false,
            extensions: ['.py'],
        });
        const res = await svc.compileAndSave(org, 'r1', {
            ...rubyRule,
            rule: 'A completely different text, so the hash does not match.',
            fileScope: {
                extensions: ['.rb'],
                sourceHash: 'whatever',
                source: 'author',
                inferredAt: new Date(),
            },
        } as any);
        expect(kodyRulesService.updateRuleFileScope).not.toHaveBeenCalled();
        expect(res.fileScope).toEqual(['.rb']);
    });

    it('still reports the detector outcome when storing the scope fails', async () => {
        const { svc, kodyRulesService } = makeWithScope({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
            extensions: ['.ts'],
        });
        kodyRulesService.updateRuleFileScope.mockRejectedValue(
            new Error('mongo down'),
        );
        const res = await svc.compileAndSave(org, 'r1', {
            ...mechanicalRule,
            rule: 'do not use console.log in TypeScript',
        });
        expect(res.compiled).toBe(true);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
    });
});

// ── the compile-attempt marker: stop paying for a verdict we already have ───
//
// The nightly sweep decided what to compile by asking "does this rule have a
// detector?". A DECLINED rule never gets one, and declining is the normal
// outcome — 816 of 10.918 active rules carry a detector, so 92,5% are declined
// — which made the whole fleet eligible again every night, forever, at the
// customer's expense (BYOK: their key, their bill).
describe('KodyRuleDetectorCompilerService — compile attempt (cost gate)', () => {
    const plainRule = {
        uuid: 'r1',
        title: 'Prefer keyword arguments',
        rule: 'Prefer keyword arguments over positional ones.',
        examples: [{ isCorrect: false, snippet: 'foo(1, 2, 3)' }],
    };

    const makeWithAttempt = (compilerOutput: any) => {
        mockRun.mockReset();
        mockRun.mockResolvedValue(compilerOutput);
        const kodyRulesService: any = {
            updateRuleDetector: jest.fn(async () => ({})),
            updateRuleContextNeed: jest.fn(async () => ({})),
            updateRuleFileScope: jest.fn(async () => ({})),
            updateRuleCompileAttempt: jest.fn(async () => ({})),
        };
        const svc = new KodyRuleDetectorCompilerService(
            { resolveTaskSlot: jest.fn(async () => null) } as any,
            {} as any,
            kodyRulesService,
        );
        return { svc, kodyRulesService };
    };

    const current = (rule: any, over: any = {}) => ({
        ...rule,
        // A rule is "settled" only when BOTH keys are current: the compile
        // attempt covers the detector, the context need is keyed separately and
        // versioned by the classifier prompt so a corrected prompt can still
        // reach a rule nobody edited.
        contextNeed: {
            need: 'diff-only',
            sourceHash: ruleContextNeedHash(rule),
            source: 'compiler',
            inferredAt: new Date('2026-01-01T00:00:00Z'),
        },
        compileAttempt: {
            sourceHash: ruleCompileHash(rule),
            attemptedAt: new Date('2026-01-01T00:00:00Z'),
            outcome: 'declined',
            declineReason: 'not-mechanical',
            ...over,
        },
    });

    it('records the attempt when the rule is DECLINED — the case that leaked', async () => {
        const { svc, kodyRulesService } = makeWithAttempt({
            mechanical: false,
            reason: 'needs judgment',
        });

        await svc.compileAndSave(org, 'r1', plainRule);

        expect(kodyRulesService.updateRuleCompileAttempt).toHaveBeenCalledTimes(
            1,
        );
        const stored = kodyRulesService.updateRuleCompileAttempt.mock.calls[0][2];
        expect(stored).toMatchObject({
            outcome: 'declined',
            declineReason: 'not-mechanical',
            sourceHash: ruleCompileHash(plainRule),
        });
    });

    it('records the attempt when the rule COMPILES too', async () => {
        const { svc, kodyRulesService } = makeWithAttempt({
            mechanical: true,
            pattern: 'foo\\(',
        });

        await svc.compileAndSave(org, 'r1', plainRule);

        expect(
            kodyRulesService.updateRuleCompileAttempt.mock.calls[0][2],
        ).toMatchObject({ outcome: 'compiled' });
    });

    it('makes NO model call when the same text and examples were already decided', async () => {
        const { svc, kodyRulesService } = makeWithAttempt({
            mechanical: false,
        });

        const res = await svc.compileAndSave(org, 'r1', current(plainRule));

        // This is the entire point: the call never happens.
        expect(mockRun).not.toHaveBeenCalled();
        expect(res.skipped).toBe(true);
        expect(res.declineReason).toBe('not-mechanical');
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
        expect(kodyRulesService.updateRuleCompileAttempt).not.toHaveBeenCalled();
    });

    it('reports the STORED outcome when it short-circuits, so counters stay right', async () => {
        const { svc } = makeWithAttempt({ mechanical: false });

        const res = await svc.compileAndSave(org, 'r1', {
            ...current(plainRule, { outcome: 'compiled' }),
            detector: { type: 'regex', pattern: 'x', extensions: ['.rb'] },
            // A CURRENT hash on purpose: short-circuiting requires both keys
            // settled, so a stale need here would (correctly) re-open the rule
            // and there would be no short circuit to assert on.
            contextNeed: {
                need: 'sibling-file',
                sourceHash: ruleContextNeedHash(plainRule),
                source: 'compiler',
                inferredAt: new Date(),
            },
            fileScope: {
                extensions: ['.rb'],
                sourceHash: 'h',
                source: 'compiler',
                inferredAt: new Date(),
            },
        } as any);

        expect(res).toMatchObject({
            compiled: true,
            scoped: true,
            contextNeed: 'sibling-file',
            fileScope: ['.rb'],
            skipped: true,
        });
    });

    it('calls the model again once the rule TEXT changes', async () => {
        const { svc } = makeWithAttempt({ mechanical: false });

        await svc.compileAndSave(org, 'r1', {
            ...current(plainRule),
            rule: 'A completely different body.',
        });

        expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('calls the model again once an EXAMPLE changes', async () => {
        // Examples gate the compile decision, so they belong in the hash. This
        // is why the marker keys on `ruleCompileHash` and not on the rule text.
        const { svc } = makeWithAttempt({ mechanical: false });

        await svc.compileAndSave(org, 'r1', {
            ...current(plainRule),
            examples: [{ isCorrect: false, snippet: 'foo(9, 9, 9)' }],
        });

        expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('records NOTHING when the attempt errored, so one bad night cannot freeze a rule', async () => {
        mockRun.mockReset();
        mockRun.mockRejectedValue(new Error('provider down'));
        const kodyRulesService: any = {
            updateRuleDetector: jest.fn(async () => ({})),
            updateRuleContextNeed: jest.fn(async () => ({})),
            updateRuleFileScope: jest.fn(async () => ({})),
            updateRuleCompileAttempt: jest.fn(async () => ({})),
        };
        const svc = new KodyRuleDetectorCompilerService(
            { resolveTaskSlot: jest.fn(async () => null) } as any,
            {} as any,
            kodyRulesService,
        );

        const res = await svc.compileAndSave(org, 'r1', plainRule);

        expect(res.declineReason).toBe('error');
        expect(kodyRulesService.updateRuleCompileAttempt).not.toHaveBeenCalled();
    });

    it('still reports the detector outcome when recording the attempt fails', async () => {
        const { svc, kodyRulesService } = makeWithAttempt({
            mechanical: true,
            pattern: 'foo\\(',
        });
        kodyRulesService.updateRuleCompileAttempt.mockRejectedValue(
            new Error('mongo down'),
        );

        const res = await svc.compileAndSave(org, 'r1', plainRule);

        expect(res.compiled).toBe(true);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
    });
});
