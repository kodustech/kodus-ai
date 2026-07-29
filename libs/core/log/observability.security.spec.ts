/**
 * Observability security + single-writer conformance (Phase 5, plan 05-08 — VERIFY-ONLY).
 *
 * Phase 3 collapsed usage-span emission onto ONE projection —
 * `buildUsageSpanAttributes` (observability.service.ts:124) — reached through the
 * public entry points `runAiSdkLLMInSpan` and `recordAgentRunUsage`. This
 * spec LOCKS two invariants that were previously "confirmed by reading":
 *
 *  1. No key material reaches an emitted span (REQ-SEC-01, SC4). The projection is a
 *     whitelist of provider:model + usage numbers, NOT a passthrough of the caller's
 *     input object. We smuggle a unique SENTINEL onto credential-shaped fields of
 *     every entry point's input (an `apiKey`/`authorization`/decrypted-key riding
 *     along, and a resolved-slot carrying an `apiKey`) and assert the SENTINEL appears
 *     NOWHERE in the serialized span attributes any path writes.
 *  2. Single writer: both wrap-exec (`runAiSdkLLMInSpan`) and post-hoc
 *     (`recordAgentRunUsage`) emit the SAME `gen_ai.usage.*` + `attributes.tu` schema
 *     for identical usage, proving both route through the one `buildUsageSpanAttributes`.
 *
 * A failing assertion here is a REAL finding (a leak or a second writer drifting from
 * the schema), NOT a test to relax.
 *
 * The observability engine is faked (a capturing span sink) so the spec runs offline
 * with no Mongo/network — it exercises the real projection, not the exporter.
 */
import { ObservabilityService } from './observability.service';

/** Unique, grep-proof stand-in for decrypted key material. Must never surface. */
const SENTINEL = 'sk-SENTINEL-4f9a2c7e-DO-NOT-LEAK-INTO-ANY-SPAN';

interface CapturingObs {
    readonly captured: Array<Record<string, any>>;
    span: { setAttributes: (a: Record<string, any>) => void; [k: string]: any };
}

/**
 * Build an ObservabilityService whose obs instance is a capturing double: every
 * `span.setAttributes(...)` payload (from EVERY code path) is recorded so the test
 * can assert over the union of what would have been persisted.
 */
function buildCapturingService(): {
    service: ObservabilityService;
    obs: CapturingObs;
} {
    const captured: Array<Record<string, any>> = [];
    const span = {
        setAttributes: (a: Record<string, any>) => {
            captured.push(a);
        },
        isRecording: () => true,
        end: () => undefined,
    };
    const fakeObs = {
        captured,
        span,
        startSpan: () => span,
        getCurrentSpan: () => span,
        getContext: () => ({ correlationId: 'test-correlation' }),
        withSpan: async (_span: unknown, fn: () => any) => fn(),
    };
    const configServiceMock = { get: jest.fn() } as any;
    const service = new ObservabilityService(configServiceMock);
    // Inject the capturing instance so getObsInstance() returns it (no real Mongo).
    (service as any).currentInstance = fakeObs;
    return { service, obs: fakeObs as unknown as CapturingObs };
}

/** Serialized union of every attribute object any span-writer received. */
function serializeCaptured(obs: CapturingObs): string {
    return JSON.stringify(obs.captured);
}

/** The single usage-carrying attribute object (the one buildUsageSpanAttributes emits). */
function usageAttrs(obs: CapturingObs): Record<string, any> {
    const hit = obs.captured.find(
        (a) => a['gen_ai.usage.total_tokens'] !== undefined,
    );
    if (!hit) {
        throw new Error(
            'no usage-carrying span attributes were emitted — the entry point did not project usage',
        );
    }
    return hit;
}

describe('no key material reaches an emitted span (REQ-SEC-01, SC4)', () => {
    it('recordAgentRunUsage: a smuggled apiKey on the params object never reaches attributes', async () => {
        const { service, obs } = buildCapturingService();

        await service.recordAgentRunUsage({
            agentName: 'code-review',
            phase: 'review',
            model: 'anthropic:claude-sonnet-4-5',
            isByok: true,
            usage: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                reasoningTokens: 20,
            },
            organizationId: 'org-1',
            teamId: 'team-1',
            // Credential-shaped fields that must NEVER be emitted. The projection
            // reads named fields only, so a stray decrypted key on the input object
            // cannot ride into telemetry.
            apiKey: SENTINEL,
            authorization: `Bearer ${SENTINEL}`,
            decryptedKey: SENTINEL,
        } as any);

        // The projection ran (guards against a silently-swallowed error faking a pass).
        expect(obs.captured.length).toBeGreaterThan(0);
        expect(usageAttrs(obs)['gen_ai.usage.total_tokens']).toBe(150);
        // The whole point: the sentinel is nowhere in what would be persisted.
        expect(serializeCaptured(obs)).not.toContain(SENTINEL);
    });

    it('runAiSdkLLMInSpan: secret material on the exec result (and its usage) never reaches attributes', async () => {
        const { service, obs } = buildCapturingService();

        await service.runAiSdkLLMInSpan({
            spanName: 'code-review::verify',
            runName: 'verify',
            model: 'openai:o3',
            attrs: { type: 'byok', organizationId: 'org-1' },
            exec: async () => ({
                // usage is the ONLY thing read off the result — and only its numeric
                // token fields. A secret smuggled alongside must not leak.
                usage: {
                    inputTokens: 200,
                    outputTokens: 80,
                    totalTokens: 280,
                    reasoningTokens: 30,
                    apiKey: SENTINEL,
                },
                apiKey: SENTINEL,
                text: `model answer mentioning ${SENTINEL}`,
            }),
        } as any);

        expect(obs.captured.length).toBeGreaterThan(0);
        expect(usageAttrs(obs)['gen_ai.usage.total_tokens']).toBe(280);
        expect(serializeCaptured(obs)).not.toContain(SENTINEL);
    });

    it('the emitted attribute KEY set carries no credential-shaped key', async () => {
        const { service, obs } = buildCapturingService();

        await service.recordAgentRunUsage({
            agentName: 'code-review',
            phase: 'review',
            model: 'anthropic:claude-sonnet-4-5',
            isByok: true,
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        });

        const keys = obs.captured.flatMap((a) => Object.keys(a));
        for (const k of keys) {
            expect(k.toLowerCase()).not.toMatch(
                /apikey|api_key|authorization|secret|password|bearer|credential|token(?!s)/,
            );
        }
    });
});

describe('single writer: both entry points project through buildUsageSpanAttributes', () => {
    const usage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 20,
    };

    it('recordAgentRunUsage and runAiSdkLLMInSpan emit an identical usage schema for identical usage', async () => {
        // Path A — post-hoc.
        const a = buildCapturingService();
        await a.service.recordAgentRunUsage({
            agentName: 'agent',
            phase: 'phase',
            model: 'openai:o3',
            isByok: true,
            usage,
        });
        const attrsA = usageAttrs(a.obs);

        // Path B — wrap-exec.
        const b = buildCapturingService();
        await b.service.runAiSdkLLMInSpan({
            spanName: 'agent::phase',
            runName: 'run',
            model: 'openai:o3',
            exec: async () => ({ usage }),
        });
        const attrsB = usageAttrs(b.obs);

        // Same numbers.
        for (const key of [
            'gen_ai.usage.input_tokens',
            'gen_ai.usage.output_tokens',
            'gen_ai.usage.total_tokens',
            'gen_ai.usage.reasoning_tokens',
        ]) {
            expect(attrsB[key]).toBe(attrsA[key]);
        }
        expect(attrsA['gen_ai.usage.input_tokens']).toBe(100);
        expect(attrsA['gen_ai.usage.output_tokens']).toBe(50);
        expect(attrsA['gen_ai.usage.total_tokens']).toBe(150);

        // Both mirror the indexable `tu` sub-doc identically (same single writer).
        expect(attrsA.tu).toBeDefined();
        expect(attrsB.tu).toBeDefined();
        expect(attrsB.tu.input).toBe(attrsA.tu.input);
        expect(attrsB.tu.output).toBe(attrsA.tu.output);
        expect(attrsB.tu.total).toBe(attrsA.tu.total);
        expect(attrsA.tu.total).toBe(150);

        // The gen_ai.usage.* key set is identical → one schema, one writer.
        const usageKeys = (o: Record<string, any>) =>
            Object.keys(o)
                .filter((k) => k.startsWith('gen_ai.usage.'))
                .sort();
        expect(usageKeys(attrsB)).toEqual(usageKeys(attrsA));
    });

    it('total is input + output (reasoning folded into output, never added on top)', async () => {
        const { service, obs } = buildCapturingService();
        await service.recordAgentRunUsage({
            agentName: 'agent',
            phase: 'phase',
            model: 'openai:o3',
            isByok: false,
            usage,
        });
        const attrs = usageAttrs(obs);
        expect(attrs['gen_ai.usage.total_tokens']).toBe(
            attrs['gen_ai.usage.input_tokens'] +
                attrs['gen_ai.usage.output_tokens'],
        );
        // reasoning is a subset detail-of output, so total must NOT include it twice.
        expect(attrs['gen_ai.usage.total_tokens']).not.toBe(
            attrs['gen_ai.usage.input_tokens'] +
                attrs['gen_ai.usage.output_tokens'] +
                attrs['gen_ai.usage.reasoning_tokens'],
        );
    });
});
