/**
 * Contract: one context window per model, whoever is asking.
 *
 * This is the FOURTH time the same defect shape showed up in this layer — one
 * question, two sources, split by which path the caller came down, drifting
 * apart in silence:
 *
 *   temperature      a `supportsTemperature` capability vs `temperaturePolicy`
 *   reasoning        two family dispatchers with disjoint family lists
 *   window (data)    a hand-typed override table vs the LiteLLM mirror
 *   window (path)    the provider registry (managed) vs the mirror (BYOK)  ← this
 *
 * The last one was the worst of the four, because the file holding the second
 * source described itself as "the single home for per-model context windows"
 * while answering `undefined` for almost every model. The managed chunker
 * therefore fell back to its caller's 64k default on models that hold a million
 * tokens, and no test could see it: `undefined` is a legal answer.
 *
 * The rule this pins is the one the architecture already implies — a provider
 * module describes TRANSPORT (how to build the client, how to list models, which
 * namespace the SDK reads); it does not define what a model IS. The window is a
 * model fact, so it has one home and both paths read it.
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from './providers';
import { managedModelMaxInputTokens } from './managed-model-window';
import {
    getModelContextWindow,
    lookupModelContextWindow,
} from './model-context-window';

/** Managed ids, in the `<vendor>:<model>` form the enum uses. The vendor prefix
 *  is OURS; the bare half is the vendor's own id, which is what the model layer
 *  is keyed by. */
const MANAGED: Array<[string, string]> = [
    ['openai:gpt-5.4', 'gpt-5.4'],
    ['anthropic:claude-opus-5', 'claude-opus-5'],
    ['anthropic:claude-sonnet-4-5', 'claude-sonnet-4-5'],
    ['google:gemini-2.5-pro', 'gemini-2.5-pro'],
    ['google:gemini-2.0-flash', 'gemini-2.0-flash'],
    ['vertex:claude-3-5-sonnet', 'claude-3-5-sonnet'],
];

describe('one window per model, managed and BYOK alike', () => {
    for (const [managedId, bareModel] of MANAGED) {
        it(`${managedId} resolves the same window on both paths`, () => {
            expect({
                id: managedId,
                managed: managedModelMaxInputTokens(managedId),
            }).toEqual({
                id: managedId,
                managed: lookupModelContextWindow(bareModel),
            });
        });
    }

    it('every managed id in the table is actually known to the model layer', () => {
        // A row resolving to `undefined` on both paths would pass the equality
        // above while telling us nothing. These are real catalog models; if one
        // stops being known, that is the mirror going stale, not a design choice.
        const unknown = MANAGED.filter(
            ([, bare]) => lookupModelContextWindow(bare) === undefined,
        );
        expect(unknown).toEqual([]);
    });

    it('no provider module declares a context window of its own', () => {
        // The seam that produced the split: two modules carried per-model window
        // tables that merely restated the model layer — one of them staler than
        // it. A provider that needs to CAP a window below the model's is a real
        // (and different) feature; it must be added as a deliberate cap, not as
        // a second place to state the same fact.
        const declaring = REGISTRY.ids().filter((id) => {
            const caps = REGISTRY.get(id).capabilities?.('probe-model') as
                | unknown
                | undefined;
            return caps ? 'maxInputTokens' in (caps as object) : false;
        });
        expect(declaring).toEqual([]);
    });

    it('the BYOK default applies only where the model is genuinely unknown', () => {
        // `getModelContextWindow` and `lookupModelContextWindow` must differ in
        // exactly one respect — the substituted default — or the two answers can
        // drift the way the two SOURCES did.
        expect(lookupModelContextWindow('not-a-real-model-xyz')).toBeUndefined();
        expect(getModelContextWindow('not-a-real-model-xyz')).toBe(128_000);
        expect(getModelContextWindow('claude-opus-5')).toBe(
            lookupModelContextWindow('claude-opus-5'),
        );
    });
});
