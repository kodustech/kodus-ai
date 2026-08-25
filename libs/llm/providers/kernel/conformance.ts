/**
 * Offline provider-module conformance harness (Phase 3, plan 03-01 — the tracer).
 *
 * D-05: prove a `ProviderModule`'s declared behavior against a RECORDED fixture by
 * driving the REAL module boundary — `module.build()` constructs the provider
 * model, and a `MockLanguageModelV4` (from `ai/test`) stands in for the network so
 * the SDK's own result assembly (`generateText` → `asLanguageModelUsage`) runs, and
 * `module.normalize` / `module.normalizeUsage` execute on the SDK-shaped result.
 *
 * This is deliberately NOT a `jest.fn()` on `tracedGenerateText` (which would skip
 * normalize entirely — RESEARCH Pitfall 4). It needs no apiKey/baseURL/network, so a
 * credential-free fork runs it as the mandatory gate (RFC §7). The credential-gated
 * live tier is a maintainer-only drift check that REFRESHES these fixtures.
 *
 * Every later provider-module plan reuses this harness: one fixture per declared
 * capability, replayed through the module it describes.
 */
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type {
    ModelResult,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderModule,
} from './types';

/**
 * A recorded provider result, stored in the high-level ai@7 `LanguageModelUsage`
 * shape — exactly what `generateText`'s result carries and what `normalize` /
 * `normalizeUsage` consume in prod. Reasoning lives at
 * `usage.outputTokenDetails.reasoningTokens` (ai@7 nested) with `usage.reasoningTokens`
 * accepted as the ai@6 flat fallback.
 */
export interface ProviderFixtureUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    outputTokenDetails?: { reasoningTokens?: number };
}

export interface ProviderFixture {
    /** The generated text content. */
    text: string;
    /** The provider finish reason (e.g. 'stop'). */
    finishReason: string;
    /** Recorded usage in the high-level LanguageModelUsage shape. */
    usage: ProviderFixtureUsage;
    /** Optional human note carried in the JSON fixture; ignored by the harness. */
    _note?: string;
}

export interface ConformanceRun {
    /** The offline model double the SDK ran against. */
    model: MockLanguageModelV4;
    /** The SDK `generateText` result — the raw fed into normalize. */
    raw: unknown;
    /** `module.normalizeUsage(raw)`. */
    usage: NormalizedUsage;
    /** `module.normalize(raw)`. */
    result: ModelResult;
}

/**
 * Convert a fixture's high-level usage into the STRUCTURED `LanguageModelV4Usage`
 * that a provider's `doGenerate` returns, so the SDK's `asLanguageModelUsage`
 * conversion runs on the way back out (proving normalize reads the SDK's real
 * output shape, not a hand-made object). `outputTokens.total` stays the FULL
 * completion count; reasoning is carried in `outputTokens.reasoning` (a detail-of,
 * NOT subtracted from total).
 */
function toV4DoGenerateUsage(u: ProviderFixtureUsage) {
    const input = u.inputTokens ?? 0;
    const output = u.outputTokens ?? 0;
    const reasoning =
        u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0;
    return {
        inputTokens: {
            total: input,
            noCache: input,
            cacheRead: 0,
            cacheWrite: 0,
        },
        outputTokens: {
            total: output,
            text: Math.max(output - reasoning, 0),
            reasoning,
        },
        raw: u,
    };
}

/**
 * Build a `MockLanguageModelV4` whose `doGenerate` replays the fixture. No network,
 * no credentials.
 */
export function buildMockFromFixture(
    cfg: ProviderBuildConfig,
    fixture: ProviderFixture,
): MockLanguageModelV4 {
    return new MockLanguageModelV4({
        modelId: cfg.model,
        doGenerate: async () => ({
            content: [{ type: 'text', text: fixture.text }],
            finishReason: fixture.finishReason as any,
            usage: toV4DoGenerateUsage(fixture.usage) as any,
            warnings: [],
        }),
    });
}

/**
 * Drive a module against a fixture through the real SDK boundary and return the
 * normalize/normalizeUsage output.
 *
 * Also asserts (offline) that `module.build(cfg)` constructs a truthy
 * `LanguageModel` — the provider factory runs, even though the mock (not that
 * model) serves the generate call.
 */
export async function runConformance(
    module: ProviderModule,
    cfg: ProviderBuildConfig,
    fixture: ProviderFixture,
): Promise<ConformanceRun> {
    // Exercise the provider factory offline — never called over the network here,
    // but it must construct without throwing (build() is a pure model factory).
    const built = module.build(cfg, { structuredOutputs: true });
    if (!built) {
        throw new Error(
            `[conformance] ${module.id}.build(cfg) returned a falsy LanguageModel`,
        );
    }

    const model = buildMockFromFixture(cfg, fixture);
    // generateText runs the SDK's real result assembly (asLanguageModelUsage),
    // so `raw.usage` comes back in the high-level shape normalize consumes.
    const raw = await generateText({ model: model as any, prompt: 'conformance' });

    return {
        model,
        raw,
        usage: module.normalizeUsage(raw),
        result: module.normalize(raw),
    };
}
