/**
 * agent-harness — CompositeVerifier (chain checkers, cheapest-first).
 *
 * Runs a PRIMARY verifier and, only when its verdict is not decisive, falls
 * through to a FALLBACK. The point: put the cheap OBJECTIVE checker first (an
 * ExecutableVerifier — tsc/lint) and pay for the expensive LLM judge only on the
 * candidates the objective signal can't settle.
 *
 * `isDecisive` decides when to trust the primary. The default trusts a primary
 * verdict iff it is high-confidence — which composes naturally with
 * ExecutableVerifier: it sets 'high' when the compiler confirms/refutes, and
 * fail-open sets 'low', so an inconclusive objective check falls through to the
 * LLM instead of silently deciding.
 */
import type {
    Verdict,
    Verifier,
} from '../../domain/contracts/verifier.contract';
import type { ToolContext } from '../../domain/contracts/tool.contract';

export class CompositeVerifier<T> implements Verifier<T> {
    constructor(
        private readonly primary: Verifier<T>,
        private readonly fallback: Verifier<T>,
        private readonly isDecisive: (v: Verdict) => boolean = (v) =>
            v.confidence === 'high',
    ) {}

    async verify(candidate: T, ctx: ToolContext): Promise<Verdict> {
        const primary = await this.primary.verify(candidate, ctx);
        if (this.isDecisive(primary)) return primary;
        return this.fallback.verify(candidate, ctx);
    }
}
