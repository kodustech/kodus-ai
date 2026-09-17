/**
 * The eval docs point at the files that own each fact instead of copying it.
 * That only holds while the pointers resolve, so the preflight fails on a stale
 * one. These pin what counts as a pointer and what does not, so the check
 * neither misses a moved file nor fails on an example.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findBrokenReferences, missingHeaderFields, repoPathOf } = require('./doc-references');

describe('eval doc references', () => {
    let root: string;
    const check = (markdown: string, scripts: Record<string, string> = {}) =>
        findBrokenReferences(markdown, { docPath: 'evals/README.md', root, scripts });

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-refs-'));
        fs.mkdirSync(path.join(root, 'evals/shared'), { recursive: true });
        fs.writeFileSync(path.join(root, 'evals/shared/tier0-models.js'), '');
        fs.writeFileSync(path.join(root, 'evals/AGENTS.md'), '');
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('accepts pointers that resolve', () => {
        const doc = 'See `evals/shared/tier0-models.js:12`, [rules](AGENTS.md) and run `pnpm eval:wiring`.';
        expect(check(doc, { 'eval:wiring': 'node evals/wiring-smoke.js' })).toEqual([]);
    });

    it('reports a moved file, a dead link, a missing script and a missing command target', () => {
        const doc = [
            'Models are in `evals/shared/tier0-registry.js`.',
            'Rules: [agents](RULES.md).',
            '```bash',
            'pnpm eval:wire',
            'node evals/gone.js --gate',
            '```',
        ].join('\n');
        expect(check(doc).map((b: { kind: string }) => b.kind).sort()).toEqual(['command', 'link', 'path', 'script']);
    });

    it('reports a stale pointer once however often it appears', () => {
        expect(check('`evals/x.js` and again `evals/x.js`')).toHaveLength(1);
    });

    it('ignores examples: globs, placeholders, external links and paths inside fenced blocks', () => {
        expect(repoPathOf('libs/code-review/**')).toBeNull();
        expect(repoPathOf('evals/scorer/cli.js --submission=<file>')).toBeNull();
        const doc = '[docs](https://example.com) `evals/<name>/README.md`\n```json\n{"path": "evals/not-real.json"}\n```';
        expect(check(doc)).toEqual([]);
    });

    it('requires the five header fields near the top of an eval README', () => {
        const full = '# X\n\n> - **Answers:** a\n> - **Runs:** b\n> - **Run it:** c\n> - **Gate:** d\n> - **Cost:** e\n';
        expect(missingHeaderFields(full)).toEqual([]);
        expect(missingHeaderFields(full.replace('> - **Cost:** e\n', ''))).toEqual(['Cost']);
    });
});
