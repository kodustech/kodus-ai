import { diffFor, fitDiff, formatPullRequestDiff } from './pull-request-diff';

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
