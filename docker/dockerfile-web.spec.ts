/**
 * The web image builds from a context that holds apps/web and only the libs
 * Dockerfile.web copies one by one. An `@libs/*` import the Dockerfile does
 * not copy builds in dev and in CI tests, then fails only in `next build`
 * inside the image ("Module not found"), which is how #2702 broke the web
 * image of main without any check going red.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const WEB_SRC = join(ROOT, 'apps/web/src');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return name === 'node_modules' || name === '__tests__'
                ? []
                : sourceFiles(path);
        }
        // Tests may import any lib: they never run inside the image.
        return /\.tsx?$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)
            ? [path]
            : [];
    });
}

function libImports(): Map<string, string> {
    const found = new Map<string, string>();
    const specifier = /(?:from|import\()\s*["'](@libs\/[^"']+)["']/g;
    for (const file of sourceFiles(WEB_SRC)) {
        for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
            if (!found.has(match[1])) {
                found.set(match[1], relative(ROOT, file));
            }
        }
    }
    return found;
}

function copiedSources(): string[] {
    const dockerfile = readFileSync(join(ROOT, 'docker/Dockerfile.web'), 'utf8');
    return [...dockerfile.matchAll(/^COPY\s+(libs\/\S+)\s+\S+/gm)].map(
        (match) => match[1],
    );
}

describe('docker/Dockerfile.web', () => {
    it('copies every lib the web imports at runtime', () => {
        const copied = copiedSources();
        const missing = [...libImports()]
            .filter(([specifier]) => {
                const path = specifier.replace(/^@libs\//, 'libs/');
                return !copied.some(
                    (source) =>
                        path === source.replace(/\.tsx?$/, '') ||
                        path.startsWith(`${source}/`),
                );
            })
            .map(([specifier, file]) => `${specifier} (imported by ${file})`);

        expect(missing).toEqual([]);
    });
});
