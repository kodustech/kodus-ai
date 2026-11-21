import { readFileSync } from 'fs';
import { join, relative, sep } from 'path';

import { isTestCode, ROOT, sources } from '../testing/source-scan';

// libs/runtime/AGENTS.md: test doubles live in testing files, never in a
// domain or adapter file, and production code never reaches them.

/** The production image refuses the dev seal key, so its config must know that key. */
const ALLOWED = new Set(['apps/runtime/src/shared/config.ts imports ../testing/dev-seal-key']);

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
export const isTestingSpecifier = (specifier: string) => /(^|\/)(testing|__tests__)(\/|$)/.test(specifier) || /\.spec$/.test(specifier);

export function violationsIn(path: string, text: string): string[] {
    const found: string[] = [];
    for (const m of text.matchAll(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(InMemory\w*)/gm)) found.push(`${path} declares ${m[1]}`);
    for (const m of text.matchAll(SPECIFIER)) if (isTestingSpecifier(m[1])) found.push(`${path} imports ${m[1]}`);
    return found;
}

describe('test doubles stay out of production code', () => {
    const production = ['apps/runtime/src', 'libs/runtime', 'libs/runtime-publish'].flatMap(sources).filter((path) => !isTestCode(path));

    it('scans the Runtime sources', () => {
        expect(production.length).toBeGreaterThan(100);
        expect(production).toContain('apps/runtime/src/hub/hub-store.ts');
        expect(relative(ROOT, __filename).split(sep).join('/')).toBe('apps/runtime/src/shared/testing-boundary.spec.ts');
    });

    it('no production file declares an InMemory class or imports a testing path', () => {
        const violations = production.flatMap((path) => violationsIn(path, readFileSync(join(ROOT, path), 'utf8'))).filter((v) => !ALLOWED.has(v));
        expect(violations).toEqual([]);
    });

    it('flags a production file that declares a double or reaches a testing path', () => {
        expect(violationsIn('a.ts', 'export class InMemoryThing {}')).toEqual(['a.ts declares InMemoryThing']);
        expect(violationsIn('a.ts', "import { X } from '../shared/persistence/testing';")).toEqual(['a.ts imports ../shared/persistence/testing']);
        expect(violationsIn('a.ts', "export * from './testing';")).toEqual(['a.ts imports ./testing']);
        expect(violationsIn('a.ts', "const m = await import('@libs/runtime/run/testing');")).toEqual(['a.ts imports @libs/runtime/run/testing']);
        expect(violationsIn('a.ts', "import { PgHubStore } from './hub-store';")).toEqual([]);
    });

    it('treats specs, fixtures, testing files and the dev folders as test code', () => {
        for (const path of ['apps/runtime/src/hub/testing.ts', 'libs/runtime/run/testing/index.ts', 'libs/runtime/api/__tests__/fixtures.ts', 'apps/runtime/src/hub/cell-hub.spec.ts', 'apps/runtime/src/e2e/fixtures.ts']) {
            expect(isTestCode(path)).toBe(true);
        }
        expect(isTestCode('apps/runtime/src/hub/hub-store.ts')).toBe(false);
    });
});
