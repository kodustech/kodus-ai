import { collectSurface } from '../collect-surface';
import {
    LanguageSurface,
    SurfaceHit,
    SurfaceRole,
    VulnClass,
} from '../surface.types';
import { createFakeGrep, createRipgrep, hasRipgrep } from './fake-grep';

export interface SurfaceCase {
    code: string;
    role: SurfaceRole;
    /** For sinks: the class that must (or must not) be flagged. */
    vulnClass?: VulnClass;
    match: boolean;
    /** Repo path; defaults to the language's default file. */
    file?: string;
    /** For positives: the pattern expected among the hits. */
    patternId?: string;
}

function allPatterns(surface: LanguageSurface) {
    return [
        ...surface.patterns,
        ...(surface.extraGlobs ?? []).flatMap((g) => g.patterns),
    ];
}

function filesFor(cases: SurfaceCase[], defaultFile: string) {
    const files: Record<string, string> = {};
    cases.forEach((c, i) => {
        files[`c${i}/${c.file ?? defaultFile}`] = c.code;
    });
    return files;
}

function relevant(hits: SurfaceHit[], c: SurfaceCase): SurfaceHit[] {
    return hits.filter(
        (h) =>
            h.role === c.role && (!c.vulnClass || h.vulnClass === c.vulnClass),
    );
}

function hitKeys(hits: SurfaceHit[]): string[] {
    return hits.map((h) => `${h.file}:${h.line}:${h.patternId}`).sort();
}

/**
 * Table-driven spec for one language: each case runs through collectSurface
 * with a fake grep; the table itself must cover 2+ entry points, an auth
 * check, a positive and a negative per vulnerability class, and every
 * language-specific pattern; and real `rg` must agree with the JS path.
 */
export function describeSurfaceCases(
    surface: LanguageSurface,
    defaultFile: string,
    cases: SurfaceCase[],
): void {
    describe(`${surface.language} surface`, () => {
        const scan = (files: Record<string, string>) =>
            collectSurface(createFakeGrep(files), {
                languages: [surface.language],
                surfaces: [surface],
            });

        cases.forEach((c) => {
            const label = `${c.match ? 'flags' : 'ignores'} ${c.role}${c.vulnClass ? `/${c.vulnClass}` : ''}: ${c.code
                .split('\n')
                .find((l) => l.trim())
                ?.trim()
                .slice(0, 70)}`;
            it(label, async () => {
                const map = await scan({ [c.file ?? defaultFile]: c.code });
                expect(map.errors).toEqual([]);
                const found = relevant(map.hits, c);
                if (c.match) {
                    expect(found.length).toBeGreaterThan(0);
                    if (c.patternId) {
                        expect(found.map((h) => h.patternId)).toContain(
                            c.patternId,
                        );
                    }
                } else {
                    expect(
                        found.map((h) => `${h.patternId}: ${h.text}`),
                    ).toEqual([]);
                }
            });
        });

        it('covers entry points, auth checks and each applicable class', () => {
            const positives = cases.filter((c) => c.match);
            expect(
                positives.filter((c) => c.role === 'entry_point').length,
            ).toBeGreaterThanOrEqual(2);
            expect(
                positives.filter((c) => c.role === 'auth_check').length,
            ).toBeGreaterThanOrEqual(1);
            const classes = new Set(
                allPatterns(surface)
                    .filter((p) => p.role === 'sink')
                    .map((p) => p.vulnClass),
            );
            const missing: string[] = [];
            for (const cls of classes) {
                const sinkCases = cases.filter(
                    (c) => c.role === 'sink' && c.vulnClass === cls,
                );
                if (!sinkCases.some((c) => c.match)) missing.push(`+${cls}`);
                if (!sinkCases.some((c) => !c.match)) missing.push(`-${cls}`);
            }
            expect(missing).toEqual([]);
        });

        it('exercises every language-specific pattern with a positive case', async () => {
            const positives = cases.filter((c) => c.match);
            const map = await scan(filesFor(positives, defaultFile));
            const hit = new Set(map.hits.map((h) => h.patternId));
            const unexercised = allPatterns(surface)
                .map((p) => p.id)
                .filter((id) => !id.includes('.common.') && !hit.has(id));
            expect(unexercised).toEqual([]);
        });

        (hasRipgrep() ? it : it.skip)(
            'real ripgrep compiles every combined regex and agrees with the JS path',
            async () => {
                const files = filesFor(cases, defaultFile);
                const rg = createRipgrep(files);
                try {
                    const viaRg = await collectSurface(rg.grep, {
                        languages: [surface.language],
                        surfaces: [surface],
                    });
                    const viaJs = await scan(files);
                    expect(viaRg.errors).toEqual([]);
                    expect(hitKeys(viaRg.hits)).toEqual(hitKeys(viaJs.hits));
                } finally {
                    rg.cleanup();
                }
            },
        );
    });
}
