import type { SurfaceMap } from './surface/surface.types';
import {
    heuristicUnits,
    languageOf,
    mergeMapPlan,
    rankCandidates,
    unitId,
} from './scan-units';

const surface = (files: SurfaceMap['files']): SurfaceMap => ({
    languages: ['typescript'],
    hits: [],
    files,
    errors: [],
});

describe('rankCandidates', () => {
    it('puts outside input meeting a dangerous operation first', () => {
        const ranked = rankCandidates(
            surface({
                'src/util.ts': { entryPoints: 0, authChecks: 0, sinks: 1, classes: ['injection'] },
                'src/api.ts': { entryPoints: 2, authChecks: 0, sinks: 1, classes: ['injection'] },
                'src/routes.ts': { entryPoints: 3, authChecks: 3, sinks: 0, classes: [] },
            }),
        );
        expect(ranked.map((c) => c.file)).toEqual([
            'src/api.ts',
            'src/util.ts',
            'src/routes.ts',
        ]);
    });

    it('checks an entry point for authorization, injection, misconfiguration and resource exhaustion even without a sink', () => {
        const [only] = rankCandidates(
            surface({
                'src/routes.ts': { entryPoints: 1, authChecks: 0, sinks: 0, classes: [] },
            }),
        );
        expect(only.classes).toEqual([
            'authz',
            'injection',
            'misconfiguration',
            'resource_exhaustion',
        ]);
    });

    it('drops a file with nothing to check', () => {
        expect(
            rankCandidates(
                surface({
                    'src/a.ts': { entryPoints: 0, authChecks: 1, sinks: 0, classes: [] },
                }),
            ),
        ).toEqual([]);
    });
});

describe('mergeMapPlan', () => {
    const candidates = rankCandidates(
        surface({
            'src/api.ts': { entryPoints: 1, authChecks: 0, sinks: 1, classes: ['injection'] },
            'src/util.ts': { entryPoints: 0, authChecks: 0, sinks: 1, classes: ['ssrf'] },
        }),
    );
    const existing = new Set([
        'src/api.ts',
        'src/util.ts',
        'src/service.ts',
        'src/db/helper.ts',
    ]);

    it('keeps the planner order and drops paths that do not exist', () => {
        const units = mergeMapPlan({
            plan: [
                { file: 'src/ghost.ts', classes: ['injection'], priority: 99 },
                {
                    file: './src/api.ts',
                    relatedFiles: ['src/service.ts', 'src/ghost.ts', 'src/api.ts'],
                    classes: ['injection', 'authz', 'xss'],
                    priority: 95,
                    reason: 'controller that queries by id',
                },
            ],
            candidates,
            existingFiles: existing,
            maxUnits: 10,
        });

        expect(units[0]).toEqual(
            expect.objectContaining({
                file: 'src/api.ts',
                relatedFiles: ['src/service.ts'],
                classes: [
                    'authz',
                    'injection',
                    'misconfiguration',
                    'resource_exhaustion',
                ],
                priority: 95,
            }),
        );
        expect(units.map((u) => u.file)).not.toContain('src/ghost.ts');
        // The heuristic fills the rest, below the planned units.
        expect(units[1]).toEqual(
            expect.objectContaining({ file: 'src/util.ts', classes: ['ssrf'] }),
        );
        expect(units[1].priority).toBeLessThanOrEqual(10);
    });

    it('never drops a class the pattern scan saw on a file the planner kept', () => {
        const units = mergeMapPlan({
            // The planner kept the file but only asked for SSRF.
            plan: [{ file: 'src/api.ts', classes: ['ssrf'], priority: 90 }],
            candidates,
            existingFiles: existing,
            maxUnits: 1,
        });

        expect(units[0].classes).toEqual([
            'authz',
            'injection',
            'ssrf',
            'misconfiguration',
            'resource_exhaustion',
        ]);
    });

    it('lets the planner add a file the pattern scan missed, and says so', () => {
        const units = mergeMapPlan({
            plan: [
                {
                    file: 'src/db/helper.ts',
                    classes: ['injection'],
                    priority: 70,
                    reason: 'raw query helper every service calls',
                },
            ],
            candidates,
            existingFiles: existing,
            maxUnits: 1,
        });

        expect(units).toHaveLength(1);
        expect(units[0].reasons[0]).toMatch(/missed/);
    });

    it('never returns more units than asked', () => {
        expect(
            mergeMapPlan({ plan: [], candidates, existingFiles: existing, maxUnits: 1 }),
        ).toHaveLength(1);
    });
});

describe('heuristicUnits', () => {
    it('gives each unit a stable id and the file language', () => {
        const [unit] = heuristicUnits(
            rankCandidates(
                surface({
                    'app/views.py': { entryPoints: 1, authChecks: 0, sinks: 1, classes: ['injection'] },
                }),
            ),
            5,
        );
        expect(unit.id).toBe(unitId('app/views.py'));
        expect(unit.language).toBe('python');
    });
});

describe('languageOf', () => {
    it.each([
        ['a.tsx', 'typescript'],
        ['a.mjs', 'typescript'],
        ['a.go', 'go'],
        ['a.kt', 'kotlin'],
        ['a.ex', 'elixir'],
        ['Makefile', 'unknown'],
    ])('%s is %s', (file, language) => {
        expect(languageOf(file)).toBe(language);
    });
});

describe('rankCandidates: the plan sees every candidate it can hold', () => {
    it('cuts at the limit it is given, and nowhere below it', () => {
        const files = Object.fromEntries(
            Array.from({ length: 450 }, (_, i) => [
                `src/f${String(i).padStart(3, '0')}.ts`,
                { entryPoints: 0, authChecks: 0, sinks: 1, classes: ['injection'] },
            ]),
        );

        expect(rankCandidates(surface(files as any))).toHaveLength(450);
        expect(rankCandidates(surface(files as any), 400)).toHaveLength(400);
    });
});
