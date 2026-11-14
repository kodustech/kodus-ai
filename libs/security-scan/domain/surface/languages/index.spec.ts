import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

import { planBatches } from '../collect-surface';
import { hasRipgrep } from '../testing/fake-grep';
import { LANGUAGE_SURFACES } from './index';

const allPatterns = LANGUAGE_SURFACES.flatMap((s) =>
    [...s.patterns, ...(s.extraGlobs ?? []).flatMap((g) => g.patterns)].map(
        (p) => ({ language: s.language, ...p }),
    ),
);

describe('LANGUAGE_SURFACES', () => {
    it('covers exactly the languages kodus-graph parses', () => {
        expect(LANGUAGE_SURFACES.map((s) => s.language).sort()).toEqual(
            [
                'bash',
                'c',
                'cpp',
                'csharp',
                'dart',
                'elixir',
                'go',
                'java',
                'kotlin',
                'php',
                'python',
                'ruby',
                'rust',
                'scala',
                'swift',
                'typescript',
            ].sort(),
        );
    });

    it('has globally unique pattern ids', () => {
        const ids = allPatterns.map((p) => p.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        expect(dupes).toEqual([]);
    });

    it('gives every sink a vulnClass and a CWE, and no vulnClass to non-sinks', () => {
        const bad = allPatterns.filter((p) =>
            p.role === 'sink'
                ? !p.vulnClass || !/^CWE-\d+$/.test(p.cwe ?? '')
                : p.vulnClass !== undefined,
        );
        expect(bad.map((p) => p.id)).toEqual([]);
    });

    it.each(allPatterns.map((p) => [p.id, p.regex]))(
        '%s compiles as a JS RegExp',
        (_id, regex) => {
            expect(() => new RegExp(regex)).not.toThrow();
        },
    );

    it('uses no lookaround, backreferences or inline flags (ripgrep has none of them)', () => {
        const offending = allPatterns.filter((p) =>
            /\(\?=|\(\?!|\(\?<=|\(\?<!|\\[1-9]|\(\?[a-z]/.test(p.regex),
        );
        expect(offending.map((p) => p.id)).toEqual([]);
    });

    it('escapes every literal brace and never uses \\< or \\> (word boundaries in Rust)', () => {
        const offending = allPatterns.filter((p) => {
            // Drop escaped chars, then character classes; what's left must
            // only use `{` as a counted repetition.
            const stripped = p.regex
                .replace(/\\./g, 'X')
                .replace(/\[(?:[^\]\\]|\\.)*\]/g, 'C');
            const braces = stripped.replace(/\{\d+(?:,\d*)?\}/g, '');
            return /[{}]/.test(braces) || /\\[<>]/.test(p.regex);
        });
        expect(offending.map((p) => p.id)).toEqual([]);
    });

    it('attributes each rg call to exactly one pattern', () => {
        for (const surface of LANGUAGE_SURFACES) {
            expect(planBatches(surface).every(batch => batch.patterns.length === 1)).toBe(true);
        }
    });

    (hasRipgrep() ? it : it.skip)(
        'every pattern compiles in ripgrep',
        () => {
            const dir = mkdtempSync(join(tmpdir(), 'surface-compile-'));
            const failures: string[] = [];
            try {
                for (const surface of LANGUAGE_SURFACES) {
                    for (const batch of planBatches(surface)) {
                        try {
                            execFileSync(
                                'rg',
                                [
                                    '--no-heading',
                                    '-n',
                                    '--glob',
                                    batch.glob,
                                    '-e',
                                    batch.patterns[0].regex,
                                    '--',
                                    '.',
                                ],
                                { cwd: dir, stdio: 'pipe' },
                            );
                        } catch (err) {
                            const e = err as {
                                status?: number;
                                stderr?: Buffer;
                            };
                            // exit 1 = no matches, the expected outcome in an empty dir.
                            if (e.status !== 1) {
                                failures.push(
                                    `${surface.language}/${batch.patterns[0].role}: ${e.stderr?.toString()}`,
                                );
                            }
                        }
                    }
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
            expect(failures).toEqual([]);
        },
    );
});
