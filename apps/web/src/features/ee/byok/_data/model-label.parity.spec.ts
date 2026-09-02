/**
 * The web copy of `formatModelLabel` must agree with the backend one.
 *
 * The duplication is DELIBERATE and documented: importing a VALUE from `@libs/*`
 * into apps/web breaks the isolated web production build, because Dockerfile.web
 * copies libs à la carte. So the web keeps a tiny local copy.
 *
 * What was missing is the part that makes a justified copy safe. Nothing pinned
 * the two together, so they could drift the way every other pair in this layer
 * drifted — and the symptom would be cosmetic-looking and confusing: the same
 * model named one way in the picker and another in a review comment.
 *
 * A test may import from `@libs` freely; the build constraint is about the
 * runtime bundle, not the test run. So the copy stays, and the drift does not.
 */
import { formatModelLabel as backend } from '@libs/llm/providers/kernel/model-label';
import PROD_SHAPES from '@libs/llm/testing/__fixtures__/byok-prod-shapes.json';

import { formatModelLabel as web } from './model-label';

/** Every distinct model id customers actually run, plus the shapes that exercise
 *  the interesting branches (deep paths, acronyms, version tokens). */
const IDS: string[] = Array.from(
    new Set(
        (PROD_SHAPES as any[])
            .map((s) => (s.slot ?? s).model)
            .filter((m: unknown): m is string => typeof m === 'string' && !!m)
            .concat([
                'gpt-5.4',
                'kimi-k2.6',
                'deepseek/deepseek-v4-pro',
                'accounts/fireworks/models/deepseek-v4-flash-0731',
                'glm-5.3',
                'claude-opus-5',
                'MiniMax-M2',
                '',
            ]),
    ),
);

describe('formatModelLabel — the web copy tracks the backend', () => {
    it('the corpus is loaded (an empty list would pass vacuously)', () => {
        expect(IDS.length).toBeGreaterThan(100);
    });

    it('produces an identical label for every production model id', () => {
        const drift = IDS.filter((id) => web(id) !== backend(id)).map((id) => ({
            id,
            web: web(id),
            backend: backend(id),
        }));
        expect(drift).toEqual([]);
    });
});
