/**
 * Contract: no family is known to HALF the system.
 *
 * "Does this model reason, and how" had two answers living in two dispatchers
 * with disjoint family lists — `model-reasoning.ts` knew claude/gemini/openai,
 * `reasoning-traits.ts` knew glm/kimi/deepseek — and each returned a perfectly
 * valid-looking "no" for the other's families. Nothing failed. The UI simply
 * told a customer their Kimi has no reasoning.
 *
 * Both now read `detectModelFamily`. This file is what keeps them reading it:
 * every member of the `ModelFamily` union needs a row, and each row states BOTH
 * answers. A family added to the union with no row fails the coverage test; a
 * family added with a row that only one resolver can answer fails its own.
 */
import { detectModelFamily, type ModelFamily } from './model-family';
import { reasoningConfigForModel } from './model-reasoning';
import { resolveCompatibleReasoningTraits } from './reasoning-traits';

type Row = {
    family: ModelFamily;
    /** A representative REASONING id for the family (the point of the table). */
    model: string;
    /** The shape `reasoningConfigForModel` must return for it. */
    config: 'level' | 'budget' | 'adaptive' | 'none';
    /** Whether the SHARED compatible table owns this family's behavior facts.
     *  False where a provider module owns them instead (claude/gemini/openai),
     *  which is a real difference, not a gap — so it is stated per row. */
    ownedByCompatibleTable: boolean;
};

const ROWS: Row[] = [
    { family: 'anthropic', model: 'claude-opus-5', config: 'adaptive', ownedByCompatibleTable: false },
    { family: 'gemini', model: 'gemini-3-pro-preview', config: 'level', ownedByCompatibleTable: false },
    { family: 'openai', model: 'o3', config: 'level', ownedByCompatibleTable: false },
    { family: 'glm', model: 'z-ai/glm-5.3', config: 'level', ownedByCompatibleTable: true },
    { family: 'kimi', model: 'moonshotai.kimi-k2.5', config: 'level', ownedByCompatibleTable: true },
    { family: 'deepseek', model: 'deepseek-v4-pro', config: 'level', ownedByCompatibleTable: true },
    // Was the gap this file first caught: config known, facts not, because
    // claiming `thinksByDefault` would have made every compatible transport emit
    // a `thinking` toggle MiniMax does not have. `reasoningControl: 'effort-only'`
    // is what let the facts be stated. 18 production slots.
    { family: 'minimax', model: 'minimax.minimax-m2', config: 'level', ownedByCompatibleTable: true },
    { family: 'unknown', model: 'prod-model-1', config: 'none', ownedByCompatibleTable: false },
];

/** Every value the union can take. Written out so adding a family to the type
 *  without adding a row here is a failing test, not a silent half-integration. */
const ALL_FAMILIES: ModelFamily[] = [
    'anthropic', 'gemini', 'openai', 'glm', 'kimi', 'deepseek', 'minimax', 'unknown',
];

describe('model families are known to the WHOLE system, or to none of it', () => {
    it('every family in the union has a row', () => {
        expect(ALL_FAMILIES.filter((f) => !ROWS.some((r) => r.family === f))).toEqual([]);
        expect(ROWS.length).toBe(ALL_FAMILIES.length);
    });

    for (const row of ROWS) {
        it(`${row.family} (${row.model})`, () => {
            expect({
                family: detectModelFamily(row.model),
                config: reasoningConfigForModel(row.model)?.type ?? 'none',
                thinks: resolveCompatibleReasoningTraits(row.model).thinksByDefault,
            }).toEqual({
                family: row.family,
                config: row.config,
                // A family the shared table owns must be answered BY it. One it
                // does not own falls to the conservative default, which never
                // forces a parameter — the safe answer for a model whose facts
                // live elsewhere (or nowhere, for a renamed proxy).
                thinks: row.ownedByCompatibleTable,
            });
        });
    }

    it('a renamed proxy is `unknown`, and unknown never forces a parameter', () => {
        // The model id is a free-text field. A proxy serving a Kimi under its own
        // name cannot be recognised, so the whole design has to be safe when it
        // recognises nothing: withhold, never impose.
        const traits = resolveCompatibleReasoningTraits('prod-model-1');
        expect({
            family: detectModelFamily('prod-model-1'),
            thinksByDefault: traits.thinksByDefault,
            config: reasoningConfigForModel('prod-model-1'),
        }).toEqual({
            family: 'unknown',
            thinksByDefault: false,
            config: undefined,
        });
    });

    it('GLM-5.3 is matched on its version token, not on loose digits', () => {
        // `includes('5.3')` pinned ANY id carrying those digits as always-thinking
        // — which withholds a `thinking: disabled` the model does accept.
        expect(resolveCompatibleReasoningTraits('glm-5.3').canDisableThinking).toBe(false);
        expect(resolveCompatibleReasoningTraits('z-ai/glm-5.3').canDisableThinking).toBe(false);
        expect(resolveCompatibleReasoningTraits('glm-5.2').canDisableThinking).toBe(true);
        // A GLM whose id merely contains the digits elsewhere is NOT GLM-5.3.
        expect(resolveCompatibleReasoningTraits('glm-4-turbo-r5.3x').canDisableThinking).toBe(true);
    });
});
