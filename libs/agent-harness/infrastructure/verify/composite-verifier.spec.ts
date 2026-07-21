import type { ToolContext } from '../../domain/contracts/tool.contract';
import type { Verdict, Verifier } from '../../domain/contracts/verifier.contract';
import { CompositeVerifier } from './composite-verifier';

const ctx = { runId: 'r1' } as ToolContext;

/** A verifier that returns a fixed verdict and counts calls. */
function stubVerifier(
    verdict: Verdict,
): Verifier<string> & { calls: () => number } {
    let count = 0;
    return {
        calls: () => count,
        async verify() {
            count++;
            return verdict;
        },
    };
}

describe('CompositeVerifier', () => {
    it('trusts the primary when its verdict is decisive — fallback not called', async () => {
        const primary = stubVerifier({ keep: false, confidence: 'high' });
        const fallback = stubVerifier({ keep: true, confidence: 'high' });
        const v = new CompositeVerifier(primary, fallback);

        const verdict = await v.verify('c', ctx);

        expect(verdict.keep).toBe(false); // primary won
        expect(primary.calls()).toBe(1);
        expect(fallback.calls()).toBe(0); // never paid for the LLM
    });

    it('falls through to the fallback when the primary is inconclusive', async () => {
        // fail-open (low confidence) is the ExecutableVerifier "I could not
        // decide" signal — it must defer to the LLM, not silently keep.
        const primary = stubVerifier({ keep: true, confidence: 'low' });
        const fallback = stubVerifier({ keep: false, confidence: 'high' });
        const v = new CompositeVerifier(primary, fallback);

        const verdict = await v.verify('c', ctx);

        expect(verdict.keep).toBe(false); // fallback decided
        expect(primary.calls()).toBe(1);
        expect(fallback.calls()).toBe(1);
    });

    it('default decisiveness = high confidence only', async () => {
        const fallback = stubVerifier({ keep: true, confidence: 'high' });

        for (const conf of ['medium', 'low', undefined] as const) {
            const primary = stubVerifier({ keep: false, confidence: conf });
            const fb = stubVerifier({ keep: true, confidence: 'high' });
            const v = new CompositeVerifier(primary, fb);
            await v.verify('c', ctx);
            expect(fb.calls()).toBe(1); // non-high primary always falls through
        }

        // high → decisive (no fallthrough)
        const highPrimary = stubVerifier({ keep: false, confidence: 'high' });
        await new CompositeVerifier(highPrimary, fallback).verify('c', ctx);
        expect(fallback.calls()).toBe(0);
    });

    it('honors a custom isDecisive predicate', async () => {
        // Trust the primary only when it REFUTES (keep:false), regardless of
        // confidence; otherwise defer.
        const primary = stubVerifier({ keep: true, confidence: 'high' });
        const fallback = stubVerifier({ keep: false, confidence: 'high' });
        const v = new CompositeVerifier(primary, fallback, (p) => p.keep === false);

        const verdict = await v.verify('c', ctx);

        expect(verdict.keep).toBe(false); // primary kept → not decisive → fallback ran
        expect(fallback.calls()).toBe(1);
    });
});
