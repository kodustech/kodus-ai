import { readdirSync } from 'fs';
import { join } from 'path';

// Walks the Runtime sources for the boundary specs (testing-boundary, config-boundary).

export const ROOT = join(__dirname, '../../../..');
/** Test and dev code by convention (apps/runtime/AGENTS.md). */
const DEV_DIRS = ['apps/runtime/src/testing/', 'apps/runtime/src/e2e/', 'apps/runtime/src/fake-cell/'];

export function sources(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
    });
}

export function isTestCode(path: string): boolean {
    const segments = path.split('/');
    return (
        /\.spec\.tsx?$/.test(path) ||
        /\.fixtures?\.ts$/.test(path) ||
        segments.includes('__tests__') ||
        segments.includes('testing') ||
        segments.includes('fixtures') ||
        segments[segments.length - 1] === 'testing.ts' ||
        DEV_DIRS.some((dir) => path.startsWith(dir))
    );
}
