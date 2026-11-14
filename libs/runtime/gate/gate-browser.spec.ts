import { decideProbe, GateStep, isMeasureField } from './gate';

// Browser probes (ADR-017): pixels alone show a visual change, never a
// behavioral regression. They are measured only when the step outcomes agree.

const IMAGE = 'img-1';
let n = 0;
const step = (side: 'base' | 'pr', round: number, fields: Record<string, string>): GateStep => ({
    stepId: `b${++n}`,
    probeId: 'orders-page',
    side,
    round,
    executor: 'observer',
    imageId: IMAGE,
    transport: 'ok',
    vmHealth: 'ok',
    timedOut: false,
    fields,
    expectedHolds: true,
});
const decide = (steps: GateStep[]) => decideProbe(steps, { pinnedImageId: IMAGE });
const OK = 'ok,ok,ok';

describe('decideProbe with browser pixel diffs', () => {
    it('a screen that changed in every PR round, with the same steps, is an inconclusive visual change', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'pixels.2': 'same' }),
            step('pr', 1, { steps: OK, 'pixels.2': 'changed' }),
            step('pr', 2, { steps: OK, 'pixels.2': 'changed' }),
        ]);
        expect(d).toMatchObject({ verdict: 'inconclusive', reason: 'Visual change only. Is this appearance change intended?', differingFields: ['pixels.2'], maskedFields: [] });
        expect(d).not.toHaveProperty('findingKind');
    });

    it('repeats a pixel-only difference before showing it as a stable visual change', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'pixels.2': 'same' }),
            step('pr', 1, { steps: OK, 'pixels.2': 'changed' }),
        ]);
        expect(d).toMatchObject({ kind: 'more_rounds', base: 0, pr: 1 });
    });

    it('a stable behavior difference still proves a finding alongside pixels', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'network.0.status': '200', 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'network.0.status': '200', 'pixels.2': 'same' }),
            step('pr', 1, { steps: OK, 'network.0.status': '500', 'pixels.2': 'changed' }),
            step('pr', 2, { steps: OK, 'network.0.status': '500', 'pixels.2': 'changed' }),
        ]);
        expect(d).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change', differingFields: ['network.0.status', 'pixels.2'] });
        expect(d).toHaveProperty('reason', 'stable base, stable PR, and they differ');
    });

    it('a changed build identity cannot turn pixels alone into a regression', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'json.sha': 'base-sha', 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'json.sha': 'base-sha', 'pixels.2': 'same' }),
            step('pr', 1, { steps: OK, 'json.sha': 'pr-sha', 'pixels.2': 'changed' }),
            step('pr', 2, { steps: OK, 'json.sha': 'pr-sha', 'pixels.2': 'changed' }),
        ]);
        expect(d).toMatchObject({ verdict: 'inconclusive', reason: 'Visual change only. Is this appearance change intended?', differingFields: ['pixels.2'] });
    });

    it('when the steps differ, the step outcome is the finding and the pixels are set aside', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'pixels.2': 'same' }),
            step('pr', 1, { steps: 'ok,ok,fail:mismatch', 'pixels.2': 'changed' }),
            step('pr', 2, { steps: 'ok,ok,fail:mismatch', 'pixels.2': 'changed' }),
        ]);
        expect(d).toMatchObject({ verdict: 'finding', differingFields: ['steps'] });
    });

    it('a round the cell could not measure is "not measured", never a difference', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'pixels.2': 'same' }),
            step('pr', 1, { steps: OK }),
            step('pr', 2, { steps: OK }),
        ]);
        expect(d).toMatchObject({ verdict: 'not_reproduced' });
    });

    it('a screen that varies between main\'s own rounds is masked, not a finding', () => {
        const d = decide([
            step('base', 1, { steps: OK, 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'pixels.2': 'changed' }),
            step('pr', 1, { steps: OK, 'pixels.2': 'changed' }),
            step('pr', 2, { steps: OK, 'pixels.2': 'changed' }),
        ]);
        expect(d).toMatchObject({ verdict: 'not_reproduced', maskedFields: ['pixels.2'] });
    });

    it('steps that vary on main make the probe inconclusive (the verdict rests on them)', () => {
        const d = decide([step('base', 1, { steps: OK }), step('base', 2, { steps: 'ok,fail:timeout,fail:skipped' }), step('pr', 1, { steps: OK }), step('pr', 2, { steps: OK })]);
        expect(d).toMatchObject({ verdict: 'inconclusive' });
    });

    it('only pixel fields are measures', () => {
        expect(isMeasureField('pixels.2')).toBe(true);
        expect(isMeasureField('steps')).toBe(false);
        expect(isMeasureField('step.3.value')).toBe(false);
    });

    it('empty observer fields stay inconclusive without inventing a visual change', () => {
        const d = decide([step('base', 1, {}), step('base', 2, {}), step('pr', 1, {}), step('pr', 2, {})]);
        expect(d).toMatchObject({ verdict: 'inconclusive', differingFields: [] });
        expect(d.reason).not.toBe('Visual change only. Is this appearance change intended?');
    });

    it('unhealthy pixel evidence cannot become a visual change', () => {
        const steps = [
            step('base', 1, { steps: OK, 'pixels.2': 'same' }),
            step('base', 2, { steps: OK, 'pixels.2': 'same' }),
            step('pr', 1, { steps: OK, 'pixels.2': 'changed' }),
            { ...step('pr', 2, { steps: OK, 'pixels.2': 'changed' }), transport: 'lost' as const },
        ];
        const d = decide(steps);
        expect(d).toMatchObject({ verdict: 'inconclusive', differingFields: [] });
        expect(d.reason).not.toBe('Visual change only. Is this appearance change intended?');
    });
});
