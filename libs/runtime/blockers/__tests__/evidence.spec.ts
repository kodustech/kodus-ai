import { classifyBlocker, fullEvidenceOf, type BlockerInput } from '../catalog';

// A failed build is fixed from what its step printed: the failing step and its
// lines, not the one line a card quotes.

const bundle = (logTail: string[], name = 'boot output') => ({
    services: [{ name, state: 'failed', logTail }],
    ports: [],
    disk: [],
    deniedEgress: [],
    redactions: 0,
    truncated: false,
    collectedAt: '2026-01-01T00:00:00.000Z',
});

const stepLines = Array.from({ length: 45 }, (_, i) => `  src/app.ts(${i},1): error TS2322: line ${i}`);
const build = (extra: Partial<BlockerInput> = {}): BlockerInput => ({
    kind: 'toolchain',
    signature: 'compose_up',
    message: 'step [build 4/6] RUN npm run build failed:',
    bundle: bundle(['step [build 4/6] RUN npm run build failed:', ...stepLines, 'docker build: exit status 1: ERROR: failed to solve']),
    ...extra,
});

describe('fullEvidenceOf', () => {
    it('names the failed build step and gives the last lines of its output, each whole', () => {
        const input = build();
        const ev = fullEvidenceOf(input, classifyBlocker(input));
        expect(ev.step).toBe('[build 4/6] RUN npm run build');
        expect(ev.lines.length).toBeGreaterThanOrEqual(40);
        expect(ev.lines.at(-1)).toBe('src/app.ts(44,1): error TS2322: line 44');
        expect(ev.lines.some((l) => l.includes('failed to solve'))).toBe(false);
    });

    it('keeps the card evidence for a blocker that is not a failed build or boot', () => {
        const input: BlockerInput = { kind: 'platform', signature: 'cell_unavailable', message: 'no cell' };
        const card = classifyBlocker(input);
        expect(fullEvidenceOf(input, card)).toEqual(card.evidence);
    });

    it('falls back to the last lines of the boot output when the cell named no step', () => {
        const lines = Array.from({ length: 60 }, (_, i) => `compose line ${i}`);
        const input = build({ message: 'compose failed', bundle: bundle(lines) });
        const ev = fullEvidenceOf(input, classifyBlocker(input));
        expect(ev.step).toBeUndefined();
        expect(ev.lines.at(-1)).toBe('compose line 59');
        expect(ev.lines.length).toBeLessThanOrEqual(49);
    });
});
