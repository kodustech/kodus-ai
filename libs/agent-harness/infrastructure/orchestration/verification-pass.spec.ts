/**
 * runVerificationPass unit tests — deterministic, fake Verifier, zero LLM.
 * Asserts refute-to-drop semantics: keep by default, drop only on explicit
 * keep:false, fail-open when the Verifier throws.
 */
import type { ToolContext } from '../../domain/contracts/tool.contract';
import type { Verifier } from '../../domain/contracts/verifier.contract';
import { runVerificationPass } from './verification-pass';

const ctx: ToolContext = { runId: 'v' };

// A Verifier whose verdict is decided by a predicate over the candidate string.
const predicateVerifier = (
    decide: (candidate: string) => boolean | 'throw',
): Verifier<string> => ({
    verify: async (candidate) => {
        const d = decide(candidate);
        if (d === 'throw') throw new Error('checker dead');
        return { keep: d, rationale: d ? 'confirmed' : 'refuted' };
    },
});

describe('runVerificationPass (refute-to-drop)', () => {
    it('keeps candidates the checker confirms, drops the refuted ones', async () => {
        const r = await runVerificationPass<string>(
            {
                candidates: ['real-bug', 'false-positive', 'real-bug-2'],
                verifier: predicateVerifier((c) => !c.includes('false-positive')),
            },
            ctx,
        );
        expect(r.kept).toEqual(['real-bug', 'real-bug-2']);
        expect(r.dropped.map((d) => d.candidate)).toEqual(['false-positive']);
        expect(r.dropped[0].verdict.rationale).toBe('refuted');
    });

    it('exposes a verdict per kept candidate (aligned with kept) carrying toolCalls', async () => {
        const verifier: Verifier<string> = {
            verify: async (candidate) => ({
                keep: !candidate.includes('drop'),
                rationale: candidate.includes('drop') ? 'refuted' : 'kept',
                // per-candidate verifier evidence rides on the verdict so the
                // domain can attribute it (e.g. which file the verifier read).
                toolCalls: [{ name: 'readFile', args: { path: `${candidate}.ts` } }],
            }),
        };
        const r = await runVerificationPass<string>(
            { candidates: ['keep-a', 'drop-b', 'keep-c'], verifier },
            ctx,
        );
        expect(r.kept).toEqual(['keep-a', 'keep-c']);
        // keptVerdicts is 1:1 and same-order as kept
        expect(r.keptVerdicts).toHaveLength(r.kept.length);
        expect(r.keptVerdicts.map((v) => v.rationale)).toEqual(['kept', 'kept']);
        // the verifier's per-candidate tool evidence is carried for survivors
        expect(r.keptVerdicts[0].toolCalls).toEqual([
            { name: 'readFile', args: { path: 'keep-a.ts' } },
        ]);
        expect(r.keptVerdicts[1].toolCalls?.[0].args).toEqual({
            path: 'keep-c.ts',
        });
        // dropped still carry their verdict (unchanged contract)
        expect(r.dropped.map((d) => d.candidate)).toEqual(['drop-b']);
    });

    it('fails OPEN: a checker error keeps the candidate (never silent-drop)', async () => {
        const r = await runVerificationPass<string>(
            { candidates: ['x'], verifier: predicateVerifier(() => 'throw') },
            ctx,
        );
        expect(r.kept).toEqual(['x']);
        expect(r.dropped).toEqual([]);
    });

    it('runs the verifier once per candidate', async () => {
        const seen: string[] = [];
        const verifier: Verifier<string> = {
            verify: async (candidate) => {
                seen.push(candidate);
                return { keep: true };
            },
        };
        await runVerificationPass<string>(
            { candidates: ['a', 'b'], verifier },
            ctx,
        );
        expect(seen.sort()).toEqual(['a', 'b']);
    });
});
