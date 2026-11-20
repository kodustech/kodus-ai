import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import * as yaml from 'js-yaml';

import { resolvePoolDocuments, type PoolDocument, type PoolSpecWriter } from './pool-apply';

// The runtime-fleet entrypoint's one-shot commands (docs/runtime/host-providers.md §5.2), run from the deploy
// pipeline with the same image as the long-running process:
//   runtime-fleet apply -f <file|dir> [-f ...] [--dry-run]
// A folder is read recursively for .yaml, .yml and .json files, in path order. Every document of every file is
// checked before anything is written; one bad document and nothing is written.

export const FLEET_USAGE = 'usage: runtime-fleet apply -f <file|dir> [-f <file|dir> ...] [--dry-run]';

export interface FleetCommandDeps {
    /** Opened only when there is something to write. */
    writer(): Promise<PoolSpecWriter>;
    out(line: string): void;
    err(line: string): void;
    allowFake: boolean;
}

const POOL_FILE = new Set(['.yaml', '.yml', '.json']);

function poolFiles(path: string): string[] {
    const st = statSync(path);
    if (st.isFile()) return [path];
    return readdirSync(path)
        .sort()
        .flatMap((name) => {
            const p = join(path, name);
            return statSync(p).isDirectory() ? poolFiles(p) : POOL_FILE.has(extname(name)) ? [p] : [];
        });
}

/** Every document of the files, or why a file could not be read (never a line of its content). */
function readDocuments(paths: string[]): { ok: true; docs: PoolDocument[] } | { ok: false; error: string } {
    const docs: PoolDocument[] = [];
    for (const root of paths) {
        let files: string[];
        try {
            files = poolFiles(root);
        } catch {
            return { ok: false, error: `${root}: no such file or folder` };
        }
        for (const file of files) {
            try {
                yaml.loadAll(readFileSync(file, 'utf8'), (doc) => {
                    if (doc !== null && doc !== undefined) docs.push({ source: `${file}#${docs.filter((d) => d.source.startsWith(`${file}#`)).length + 1}`, doc });
                });
            } catch (e) {
                const line = (e as { mark?: { line?: number } }).mark?.line;
                return { ok: false, error: `${file}: not valid YAML${line !== undefined ? ` (line ${line + 1})` : ''}` };
            }
        }
    }
    return { ok: true, docs };
}

export async function runFleetCommand(argv: string[], d: FleetCommandDeps): Promise<number> {
    const [command, ...rest] = argv;
    if (command !== 'apply') {
        d.err(FLEET_USAGE);
        return 2;
    }
    const paths: string[] = [];
    let dryRun = false;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--dry-run') dryRun = true;
        else if ((rest[i] === '-f' || rest[i] === '--file') && rest[i + 1]) paths.push(rest[++i]);
        else {
            d.err(FLEET_USAGE);
            return 2;
        }
    }
    if (!paths.length) {
        d.err(FLEET_USAGE);
        return 2;
    }
    const read = readDocuments(paths);
    if (read.ok === false) {
        d.err(read.error);
        return 1;
    }
    const resolved = resolvePoolDocuments(read.docs, { allowFake: d.allowFake });
    if (resolved.ok === false) {
        for (const e of resolved.errors) d.err(e);
        d.err('nothing was applied');
        return 1;
    }
    if (dryRun) {
        for (const p of resolved.pools) d.out(`valid ${p.poolId} (spec ${p.specHash})`);
        return 0;
    }
    const writer = await d.writer();
    try {
        for (const r of await writer.apply(resolved.pools)) d.out(`${r.action} ${r.poolId} (spec ${r.specHash})`);
        return 0;
    } catch (e) {
        d.err((e as Error).name === 'PoolApplyRefused' ? (e as Error).message : 'apply failed: the database refused the write; nothing was applied');
        return 1;
    } finally {
        await writer.close?.();
    }
}
