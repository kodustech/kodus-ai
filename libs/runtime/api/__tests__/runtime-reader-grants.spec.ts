import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// The API reads the Runtime database as kodus_runtime_reader, with only the
// grants of scripts/runtime/runtime-reader-grants.sql (applied after the
// Runtime's first boot of each release). A reader of a table that script does
// not grant answers 503 in production while every unit test passes, since
// those never use the role: every Runtime table a product reader names must
// be granted there.
const ROOT = resolve(__dirname, '../../../..');
const GRANTS = readFileSync(join(ROOT, 'scripts/runtime/runtime-reader-grants.sql'), 'utf8');
const READER_DIRS = ['libs/runtime/api/infrastructure', 'libs/runtime/run/adapters', 'libs/runtime-publish'];

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(path);
        return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [path] : [];
    });
}

describe('the Runtime reader role', () => {
    it('is granted every Runtime table the product readers name', () => {
        const named = new Set<string>();
        for (const file of READER_DIRS.flatMap((d) => sources(join(ROOT, d))))
            for (const m of readFileSync(file, 'utf8').matchAll(/\bruntime\.(runtime_[a-z_]+)\b/g)) named.add(m[1]);
        expect(named.size).toBeGreaterThan(10);
        const granted = new Set([...GRANTS.matchAll(/'(runtime_[a-z_]+)'|runtime\.(runtime_[a-z_]+)/g)].map((m) => m[1] ?? m[2]));
        expect([...named].filter((t) => !granted.has(t)).sort()).toEqual([]);
    });
});
