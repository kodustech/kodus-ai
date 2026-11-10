// Dumps protocolJsonSchemas() to the file the Go cell generates its types from.
// Usage: ts-node -r tsconfig-paths/register --transpile-only \
//   libs/runtime/protocol/scripts/dump-json-schema.ts [out.json]
import { writeFileSync } from 'node:fs';

import { MAX_DEPTH, MAX_FRAME_BYTES, PROTOCOL_VERSION, protocolJsonSchemas } from '../envelope';

const out = process.argv[2] ?? 'apps/runtime-cell/internal/protocol/schema/protocol.schema.json';
const doc = {
    protocolVersion: PROTOCOL_VERSION,
    maxFrameBytes: MAX_FRAME_BYTES,
    maxDepth: MAX_DEPTH,
    schemas: protocolJsonSchemas(),
};
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out}`);
