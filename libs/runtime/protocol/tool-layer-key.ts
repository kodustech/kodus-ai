import { createHash } from 'node:crypto';

// The key of a tool layer (docs/runtime/persistent-state.md 4.1): sha256 of a
// canonical record, the same bytes the Go cell's toollayer.ComputeKey hashes
// (apps/runtime-cell/internal/drivers/dockergvisor/toollayer/key.go). The two
// are held to each other by tool-layer-key.json, run by both suites. The org
// is not in the key: it is the directory the cell stores the layer in.

/** Part of every key: a change in how layers are made starts new keys (Go: LayerFormat). */
export const TOOL_LAYER_FORMAT = 1;

export interface ToolLayerKeyInput {
    installer: string;
    /** The install argv after the API's plan, so --ignore-scripts is part of it. */
    argv: readonly string[];
    binary: string;
    /** The sandbox image's content digest, sha256:<64 hex>. */
    imageDigest: string;
    /** The architecture name of the cell's hello (arm64, x86_64), the one the cell hashes. */
    arch: string;
    registry: string;
}

export class ToolLayerKeyError extends Error {
    constructor(
        readonly code: 'no_image_digest' | 'incomplete',
        message: string,
    ) {
        super(message);
    }
}

/** Built from code points, so no line terminator sits in the source of a literal. */
const GO_ESCAPED = new Set(['<', '>', '&', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Go's encoding/json writes `<`, `>`, `&`, U+2028 and U+2029 as \u escapes in
 * a string, where JSON.stringify leaves them; everything else (quotes,
 * backslashes, controls) both write alike. They occur only inside strings.
 */
function goJson(value: unknown): string {
    let out = '';
    for (const ch of JSON.stringify(value)) out += GO_ESCAPED.has(ch) ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch;
    return out;
}

/** The key, or a ToolLayerKeyError: no digest means no layer, and the caller installs as today. */
export function computeToolLayerKey(input: ToolLayerKeyInput): string {
    if (!IMAGE_DIGEST.test(input.imageDigest)) throw new ToolLayerKeyError('no_image_digest', 'a tool layer key needs the sandbox image digest (sha256:<64 hex>)');
    if (!input.installer || !input.argv.length || !input.binary || !input.arch || !input.registry) {
        throw new ToolLayerKeyError('incomplete', 'a tool layer key needs the installer, argv, binary, arch and registry');
    }
    // The field order is Go's keyRecord; JSON gives every argv element its own boundary.
    const record = {
        layerFormat: TOOL_LAYER_FORMAT,
        installer: input.installer,
        argv: [...input.argv],
        binary: input.binary,
        imageDigest: input.imageDigest,
        arch: input.arch,
        registry: input.registry,
    };
    return createHash('sha256').update(goJson(record)).digest('hex');
}
