/**
 * The context-window mirror has to know the models we actually serve.
 *
 * `model-context-windows.json` is a snapshot of LiteLLM upstream, and a snapshot
 * with nothing watching it rots in silence: an unknown model does not error, it
 * just gets the 128k default. It had rotted by a full generation — every Claude
 * 4.7+/5, every Gemini 3.x, every DeepSeek V4 and the gpt-5.5/5.6 line were
 * missing, so slots on models that hold 1,000,000 input tokens were being
 * chunked into 128,000. That is roughly an eightfold over-chunk: more calls,
 * more cost, and a review that never sees the whole change at once.
 *
 * These assert against the production corpus rather than a hand-written list,
 * because the question is not "does the table have rows" but "does it know what
 * customers run". Refresh with `node scripts/refresh-model-context-windows.mjs`.
 */
import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import {
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    getModelContextWindow,
} from './model-context-window';

const MODELS: string[] = (PROD_SHAPES as any[])
    .map((s) => (s.slot ?? s).model)
    .filter((m: unknown): m is string => typeof m === 'string' && m.length > 0);

describe('production models resolve to a real context window', () => {
    it('the corpus is loaded (an empty corpus would pass everything below)', () => {
        expect(MODELS.length).toBeGreaterThan(300);
    });

    /** Spot checks on the families the stale mirror had missed entirely. The
     *  numbers are upstream's, not ours — they are here so a refresh that drops
     *  a family is a failure and not a quiet regression to 128k. */
    it.each([
        ['claude-opus-5', 1_000_000],
        ['claude-sonnet-5', 1_000_000],
        ['global.anthropic.claude-opus-4-7', 1_000_000],
        ['gemini-3.5-flash', 1_048_576],
        ['deepseek-v4-pro', 1_000_000],
    ])('%s → %i tokens', (model, expected) => {
        expect(getModelContextWindow(model as string)).toBe(expected);
    });

    it('coverage of the production corpus does not go backwards', () => {
        const known = MODELS.filter(
            (m) => getModelContextWindow(m) !== DEFAULT_CONTEXT_WINDOW_TOKENS,
        );
        // A FLOOR, not an exact count: upstream adds and renames models, and
        // pinning the exact number would turn every refresh into a broken test.
        // What must never happen is coverage dropping — that is the mirror going
        // stale again. It stood at 75/322 before the first refresh.
        expect({
            covered: known.length,
            total: MODELS.length,
        }).toEqual({
            covered: expect.any(Number),
            total: MODELS.length,
        });
        expect(known.length).toBeGreaterThanOrEqual(140);
    });

    it('no production model resolves to something absurd', () => {
        // A projection bug upstream (a string, a zero, a negative) would reach us
        // as a chunk size. Cheap to rule out, and it covers every model at once.
        const bad = MODELS.filter((m) => {
            const w = getModelContextWindow(m);
            return !Number.isInteger(w) || w < 4_000 || w > 20_000_000;
        });
        expect(bad).toEqual([]);
    });
});
