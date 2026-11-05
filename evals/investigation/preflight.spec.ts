// eslint-disable-next-line @typescript-eslint/no-require-imports
const { expectedRun, checkManifest } = require('./preflight');

const LEAN = ['label', 'relevantFile', 'relevantLinesEnd', 'relevantLinesStart', 'suggestionContent'];

// A case that ran exactly as a balanced DeepSeek run asks: rescue on, three
// categories, lean output, local sandbox, every step.
const manifest = (over: Record<string, unknown> = {}, loop: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({
    stages: 'full',
    stoppedAfter: null,
    route: 'byok',
    sandbox: { type: 'local', hasRun: true },
    loops: [
        {
            agentName: 'kodus-generalist-review-agent',
            modelName: 'deepseek-x',
            reasoningEffort: 'medium',
            heavy: false,
            skipSynthesisRescue: false,
            allowedLabels: ['bug', 'performance', 'security'],
            callGraphChars: 900,
            ...loop,
        },
    ],
    finderRuns: [{ agentName: 'kodus-generalist-review-agent', passes: ['generalist', 'synthesis-rescue'], submittedFields: LEAN, verify: 'ran', candidates: 3, ...run }],
    ...over,
});
const expected = (env: Record<string, string> = {}, rescue = true) =>
    expectedRun({ env: { RECALL_REASONING_EFFORT: 'medium', ...env }, model: 'deepseek-x', profile: { synthesisRescue: rescue }, lensCount: 9 });

describe('evals/investigation/preflight.js', () => {
    it('passes a case that ran as asked', () => {
        expect(checkManifest(manifest(), expected()).problems).toEqual([]);
    });

    it('fails a review with no sandbox', () => {
        expect(checkManifest(manifest({ sandbox: null }), expected()).problems.join()).toMatch(/sandbox/);
    });

    it('fails when the generalist got fewer categories than asked', () => {
        expect(checkManifest(manifest({}, { allowedLabels: ['bug'] }), expected()).problems.join()).toMatch(/categories/);
    });

    it('fails another model or a missing effort', () => {
        expect(checkManifest(manifest({}, { modelName: 'other' }), expected()).problems.join()).toMatch(/model/);
        expect(checkManifest(manifest({}, { reasoningEffort: null }), expected()).problems.join()).toMatch(/effort/);
    });

    it('fails a rescue that did not follow the model profile', () => {
        expect(checkManifest(manifest({}, {}, { passes: ['generalist'] }), expected()).problems.join()).toMatch(/rescue/);
        const offProfile = expected({}, false);
        expect(checkManifest(manifest(), offProfile).problems.join()).toMatch(/rescue/);
        expect(checkManifest(manifest({}, { skipSynthesisRescue: true }, { passes: ['generalist'] }), offProfile).problems).toEqual([]);
    });

    it('fails a finder output that is not the lean five fields', () => {
        expect(checkManifest(manifest({}, {}, { submittedFields: [...LEAN, 'existingCode'] }), expected()).problems.join()).toMatch(/lean/);
    });

    it('checks the stages: finder runs no verify and stops after the agents', () => {
        const finderOnly = expected({ RECALL_STAGES: 'finder' });
        expect(checkManifest(manifest({ stages: 'finder', stoppedAfter: 'finder' }, {}, { verify: 'not-run' }), finderOnly).problems).toEqual([]);
        expect(checkManifest(manifest({ stages: 'finder', stoppedAfter: 'finder' }), finderOnly).problems.join()).toMatch(/verify/);
        expect(checkManifest(manifest(), finderOnly).problems.join()).toMatch(/stages/);
    });

    it('expects every M3 lens on a heavy run, none on a balanced one', () => {
        const lenses = Array.from({ length: 9 }, (_, i) => `lens-${i}`);
        const heavy = expected({ RECALL_HEAVY: '1' });
        expect(checkManifest(manifest({}, { heavy: true }, { passes: ['generalist', 'synthesis-rescue', ...lenses] }), heavy).problems).toEqual([]);
        expect(checkManifest(manifest({}, { heavy: true }), heavy).problems.join()).toMatch(/lens/);
        expect(checkManifest(manifest({}, {}, { passes: ['generalist', 'synthesis-rescue', 'lens-a'] }), expected()).problems.join()).toMatch(/lens/);
    });

    it('takes the categories a run sets', () => {
        const two = expected({ RECALL_CATEGORIES: 'security,bug' });
        expect(checkManifest(manifest({}, { allowedLabels: ['bug', 'security'] }), two).problems).toEqual([]);
    });
});
