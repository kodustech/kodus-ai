import { estimateTextTokens } from '@libs/llm/token-estimate';
import {
    diffFor,
    diffTokenBudget,
    fitDiff,
    formatPullRequestDiff,
} from './pull-request-diff';

/** SVG path data: few characters per token, the shape behind #2233. */
const svgPatch = (chars: number) => {
    let out = '';
    for (let i = 0; out.length < chars; i++) {
        out += `+<path d="M${i % 97}.${i % 7} ${i % 13}.5L${i % 31} ${i % 11}z"/>\n`;
    }
    return out.slice(0, chars);
};

describe('fitDiff (UC-32)', () => {
    const diff = formatPullRequestDiff([
        { filename: 'a.ts', patch: '+'.repeat(40) },
        { filename: 'huge.ts', patch: '+'.repeat(500) },
        { filename: 'b.ts', patch: '+'.repeat(40) },
    ]);

    it('keeps a diff under budget whole', () => {
        expect(fitDiff(diff, 10_000)).toEqual({ diff, unseenFiles: [] });
    });

    it('skips a file that does not fit and keeps the smaller ones after it', () => {
        const fitted = fitDiff(diff, 200);
        expect(fitted.unseenFiles).toEqual(['huge.ts']);
        expect(fitted.diff).toContain('=== FILE: a.ts ===');
        expect(fitted.diff).toContain('=== FILE: b.ts ===');
        expect(fitted.diff.length).toBeLessThanOrEqual(200);
    });

    it('reads unified diff headers from a local diff too', () => {
        const local = `diff --git a/x.ts b/x.ts\n${'+'.repeat(300)}\ndiff --git a/y.ts b/y.ts\n+ok\n`;
        expect(fitDiff(local, 100).unseenFiles).toEqual(['x.ts']);
    });
});

describe('diffFor: what one second look re-reads on every step', () => {
    const file = (name: string, size: number) =>
        `=== FILE: ${name} ===\nStatus: modified\n\n${'+'.repeat(size)}\n`;

    it('sends a small diff whole', () => {
        const diff = file('a.ts', 10) + file('b.ts', 10);
        expect(diffFor(diff, {}, 1000)).toBe(diff);
    });

    it('puts the files the evidence cites first, and names the rest for read_file', () => {
        const diff =
            file('a.ts', 400) + file('b.ts', 400) + file('cited.ts', 400);
        const sent = diffFor(diff, { files: ['cited.ts'] }, 1000);
        expect(sent.indexOf('=== FILE: cited.ts')).toBe(0);
        expect(sent).toContain('=== FILE: a.ts');
        expect(sent).not.toContain('=== FILE: b.ts');
        expect(sent).toMatch(
            /not shown here \(read them with read_file\): b\.ts$/,
        );
    });

    it('keeps the names of the files left out inside the budget', () => {
        const diff = Array.from({ length: 500 }, (_, i) =>
            file(`src/features/module-${i}/handler.ts`, 400),
        ).join('');
        const sent = diffFor(diff, {}, 24_000);
        expect(sent.length).toBeLessThanOrEqual(24_000);
        expect(sent).toMatch(/… and \d+ more$/);
    });

    it('picks the files that share words with a requirement no evidence cites', () => {
        const diff =
            file('src/a.ts', 500) +
            file('src/b.ts', 500) +
            `=== FILE: src/export/invoice-pdf.ts ===\nStatus: added\n\n+export function invoicePdf() {}\n${'+'.repeat(400)}\n`;
        const sent = diffFor(
            diff,
            { requirement: 'Invoices can be exported as PDF' },
            1000,
        );
        expect(sent.indexOf('=== FILE: src/export/invoice-pdf.ts')).toBe(0);
    });

    it('cuts a file too large for the room left instead of dropping it', () => {
        const sent = diffFor(file('huge.ts', 50_000), {}, 24_000);
        expect(sent).toContain('=== FILE: huge.ts');
        expect(sent).toContain('read the rest of huge.ts with read_file');
        expect(sent.length).toBeLessThanOrEqual(24_000);
    });
});

describe("fitDiff within the model's window (#2233)", () => {
    const diff = formatPullRequestDiff([
        { filename: 'src/a.ts', patch: svgPatch(30_000) },
        { filename: 'icons/big.svg', patch: svgPatch(120_000) },
        { filename: 'src/b.ts', patch: svgPatch(30_000) },
    ]);

    it('leaves out the files that would take the diff past the tokens, and names them, even under the character cap', () => {
        const tokens = 30_000;
        const { diff: sent, unseenFiles } = fitDiff(diff, {
            chars: 200_000,
            tokens,
        });
        expect(diff.length).toBeLessThan(200_000);
        expect(estimateTextTokens(sent)).toBeLessThanOrEqual(tokens);
        expect(unseenFiles).toContain('icons/big.svg');
        expect(sent).toContain('=== FILE: src/a.ts');
    });

    it('cuts a diff with no file headers to the tokens too', () => {
        const { diff: sent, unseenFiles } = fitDiff(svgPatch(100_000), {
            chars: 200_000,
            tokens: 5_000,
        });
        expect(estimateTextTokens(sent)).toBeLessThanOrEqual(5_000);
        expect(sent.length).toBeGreaterThan(0);
        expect(unseenFiles).toEqual(['(rest of the diff)']);
    });

    it('keeps the whole diff when the window holds it', () => {
        expect(fitDiff(diff, { chars: 200_000, tokens: 1_000_000 })).toEqual({
            diff,
            unseenFiles: [],
        });
    });
});

describe('diffTokenBudget (#2233)', () => {
    it('gives the diff what the window holds after the prompt, the answer and a margin', () => {
        expect(
            diffTokenBudget({
                contextWindowTokens: 100_000,
                promptTokens: 10_000,
                outputTokens: 20_000,
            }),
        ).toBe(60_000);
    });

    it('leaves nothing for the diff when the window cannot hold the prompt and the answer', () => {
        expect(
            diffTokenBudget({
                contextWindowTokens: 16_000,
                promptTokens: 4_000,
                outputTokens: 20_000,
            }),
        ).toBe(0);
    });
});

describe("diffFor within the model's window (#2233)", () => {
    it("keeps a second look's diff within its tokens and still names the files left out", () => {
        const diff = formatPullRequestDiff(
            Array.from({ length: 12 }, (_, i) => ({
                filename: `icons/icon-${i}.svg`,
                patch: svgPatch(4_000),
            })),
        );
        const sent = diffFor(diff, {}, { chars: 24_000, tokens: 2_000 });
        expect(estimateTextTokens(sent)).toBeLessThanOrEqual(2_000);
        expect(sent).toContain('Also changed, not shown here');
    });
});
