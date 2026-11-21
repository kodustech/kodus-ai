// Writes what the Go cell is generated from, from the TypeScript protocol:
//   - internal/protocol/schema/protocol.schema.json, protocolJsonSchemas()
//     (go generate ./internal/protocol turns it into types_gen.go);
//   - internal/protocol/constants_gen.go, the constants and patterns the
//     schemas do not carry (go-constants.ts).
// With --check it writes nothing and exits 1 when a checked-in file is stale.
// Usage, from the repository root:
//   node -r ts-node/register/transpile-only -r tsconfig-paths/register \
//     libs/runtime/protocol/scripts/dump-json-schema.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { MAX_DEPTH, MAX_FRAME_BYTES, PROTOCOL_VERSION, protocolJsonSchemas } from '../envelope';
import { renderGoConstants } from './go-constants';

/** The generated files, relative to the repository root. */
export const GENERATED_FILES = {
    schema: 'apps/runtime-cell/internal/protocol/schema/protocol.schema.json',
    constants: 'apps/runtime-cell/internal/protocol/constants_gen.go',
} as const;

/** Each generated file's content, by its path relative to the repository root. */
export function generatedFiles(): Record<string, string> {
    const doc = {
        protocolVersion: PROTOCOL_VERSION,
        maxFrameBytes: MAX_FRAME_BYTES,
        maxDepth: MAX_DEPTH,
        schemas: protocolJsonSchemas(),
    };
    return {
        [GENERATED_FILES.schema]: JSON.stringify(doc, null, 2) + '\n',
        [GENERATED_FILES.constants]: renderGoConstants(),
    };
}

/** Writes every generated file under root; returns the paths written. */
export function writeGeneratedFiles(root: string): string[] {
    return Object.entries(generatedFiles()).map(([path, content]) => {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        return path;
    });
}

/** The generated files under root that are missing or differ from what the generator writes now. */
export function staleGeneratedFiles(root: string): string[] {
    return Object.entries(generatedFiles())
        .filter(([path, content]) => {
            try {
                return readFileSync(join(root, path), 'utf8') !== content;
            } catch {
                return true;
            }
        })
        .map(([path]) => path);
}

if (require.main === module) {
    const root = resolve(__dirname, '../../../..');
    if (process.argv.includes('--check')) {
        const stale = staleGeneratedFiles(root);
        for (const path of stale) console.error(`stale: ${path} (run libs/runtime/protocol/scripts/dump-json-schema.ts)`);
        process.exit(stale.length ? 1 : 0);
    }
    for (const path of writeGeneratedFiles(root)) console.log(`wrote ${path}`);
}
