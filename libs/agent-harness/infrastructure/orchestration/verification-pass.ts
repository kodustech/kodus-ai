/**
 * agent-harness — runVerificationPass: a generic "checker" pass over a list of
 * candidate outputs. It runs ONE Verifier per candidate (bounded concurrency)
 * and partitions the results in plain code. This is the harness-owned gate: the
 * agent cannot self-accept — only a Verdict from the injected Verifier moves a
 * candidate to kept.
 *
 * The Verifier is a PORT (verifier.contract): it can be an LLM judge OR an
 * executable command (compiler/linter/test). This pass doesn't know or care —
 * it just collects verdicts. The domain decides what "verify" means.
 *
 * Default semantics: KEEP. A candidate is dropped ONLY on an explicit
 * keep:false. A Verifier that throws fails OPEN (keep) — infra failure must
 * never silently drop a candidate.
 */
import type { ToolContext } from '../../domain/contracts/tool.contract';
import type {
    Verdict,
    Verifier,
} from '../../domain/contracts/verifier.contract';

export interface VerificationPassParams<T> {
    readonly candidates: readonly T[];
    readonly verifier: Verifier<T>;
    /** Max verifications in flight. Default 4. */
    readonly concurrency?: number;
}

export interface VerificationPassResult<T> {
    readonly kept: T[];
    readonly dropped: Array<{ candidate: T; verdict: Verdict }>;
    /** The verdict for each KEPT candidate, in the same order as `kept`. Lets
     *  callers attribute per-candidate verifier evidence/rationale to survivors
     *  (the dropped already carry their verdict). */
    readonly keptVerdicts: Verdict[];
}

export async function runVerificationPass<T>(
    params: VerificationPassParams<T>,
    ctx: ToolContext,
): Promise<VerificationPassResult<T>> {
    const { candidates, verifier } = params;
    const concurrency = Math.max(1, params.concurrency ?? 4);

    const kept: T[] = [];
    const keptVerdicts: Verdict[] = [];
    const dropped: Array<{ candidate: T; verdict: Verdict }> = [];

    for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        const verdicts = await Promise.all(
            batch.map(async (candidate) => {
                try {
                    return { candidate, verdict: await verifier.verify(candidate, ctx) };
                } catch {
                    // Fail OPEN: infra failure must never silently drop a candidate.
                    return { candidate, verdict: { keep: true } as Verdict };
                }
            }),
        );
        for (const { candidate, verdict } of verdicts) {
            if (verdict.keep) {
                kept.push(candidate);
                keptVerdicts.push(verdict);
            } else dropped.push({ candidate, verdict });
        }
    }

    return { kept, keptVerdicts, dropped };
}
