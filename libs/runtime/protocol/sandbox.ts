import { z } from 'zod';

// The code sandbox's operations (docs/runtime/sandbox.md): one shape from the
// worker to the hub, from the hub to the cell (sandbox.op) and from the cell
// to the guest agent inside the machine (the same sandbox.op frame over its
// byte stream: a unix socket or docker exec's stdio today, vsock in a
// microVM). The guest agent answers guest.result; the cell sends the result
// on in step.result `sandbox`. Every bound below is enforced by the guest
// agent itself (apps/runtime-cell/internal/guest) and again by both decoders.

/** Most bytes one read returns, and one write takes (raw, before base64). */
export const SANDBOX_FILE_CHUNK_BYTES = 512 * 1024;
/** Base64 of SANDBOX_FILE_CHUNK_BYTES. */
export const SANDBOX_FILE_CHUNK_BASE64 = Math.ceil(SANDBOX_FILE_CHUNK_BYTES / 3) * 4;
/** What an exec keeps of each stream (UTF-8 bytes); the rest is dropped and the result says truncated. */
export const SANDBOX_EXEC_STDOUT_BYTES = 192 * 1024;
export const SANDBOX_EXEC_STDERR_BYTES = 32 * 1024;
/** Most entries one list returns; the guest agent also stops early to keep the frame under the limit. */
export const SANDBOX_LIST_MAX_ENTRIES = 5_000;
export const SANDBOX_LIST_MAX_DEPTH = 16;
export const SANDBOX_EXEC_MAX_ENV = 32;
export const SANDBOX_PATH_MAX = 4_096;

// A path under the sandbox's root (/workspace): plain segments only, never
// absolute, never `.` or `..`, no backslash or NUL. The guest agent opens it
// one segment at a time without following a symbolic link.
const SEGMENT = '(?:[^/\\\\.\\x00][^/\\\\\\x00]*|\\.[^/\\\\.\\x00][^/\\\\\\x00]*|\\.\\.[^/\\\\\\x00]+)';
export const SANDBOX_PATH_PATTERN = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`);
const SandboxPathSchema = z.string().min(1).max(SANDBOX_PATH_MAX).regex(SANDBOX_PATH_PATTERN);
const EnvKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const base64 = z
    .string()
    .max(SANDBOX_FILE_CHUNK_BASE64)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const SANDBOX_OPS = ['exec', 'read', 'write', 'list', 'stat', 'remove'] as const;
export type SandboxOpKind = (typeof SANDBOX_OPS)[number];

/**
 * One operation. Flat (the Go cell generates its types from this schema): the
 * fields an op does not use are refused by sandboxOpError.
 *   exec:   command, timeoutMs; cwd, env optional.
 *   read:   path; offset (default 0) and length (default and most: one chunk).
 *   write:  path, content (base64); mode, append, mkdirs optional.
 *   list:   path (absent: the root); depth (default 1), maxEntries.
 *   stat:   path (absent: the root).
 *   remove: path; a file or a symbolic link itself, never a directory, never followed.
 */
export const SandboxOpSchema = z.strictObject({
    op: z.enum(SANDBOX_OPS),
    path: SandboxPathSchema.optional(),
    command: z.string().min(1).max(16_384).optional(),
    cwd: SandboxPathSchema.optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    env: z.record(EnvKeySchema, z.string().max(8_192)).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().min(1).max(SANDBOX_FILE_CHUNK_BYTES).optional(),
    content: base64.optional(),
    mode: z.number().int().min(0).max(0o777).optional(),
    append: z.boolean().optional(),
    mkdirs: z.boolean().optional(),
    depth: z.number().int().min(1).max(SANDBOX_LIST_MAX_DEPTH).optional(),
    maxEntries: z.number().int().min(1).max(SANDBOX_LIST_MAX_ENTRIES).optional(),
});
export type SandboxOp = z.infer<typeof SandboxOpSchema>;

const USES: Record<SandboxOpKind, { required: (keyof SandboxOp)[]; optional: (keyof SandboxOp)[] }> = {
    exec: { required: ['command', 'timeoutMs'], optional: ['cwd', 'env'] },
    read: { required: ['path'], optional: ['offset', 'length'] },
    write: { required: ['path', 'content'], optional: ['mode', 'append', 'mkdirs'] },
    list: { required: [], optional: ['path', 'depth', 'maxEntries'] },
    stat: { required: [], optional: ['path'] },
    remove: { required: ['path'], optional: [] },
};

/** Why an op is malformed for its kind, or undefined (the Go cell's protocol.refine says the same). */
export function sandboxOpError(o: SandboxOp): string | undefined {
    const use = USES[o.op];
    for (const k of use.required) if (o[k] === undefined) return `${o.op} needs ${k}`;
    for (const k of Object.keys(o) as (keyof SandboxOp)[]) {
        if (k !== 'op' && !use.required.includes(k) && !use.optional.includes(k)) return `${o.op} takes no ${k}`;
    }
    if (o.env && Object.keys(o.env).length > SANDBOX_EXEC_MAX_ENV) return `exec takes at most ${SANDBOX_EXEC_MAX_ENV} env entries`;
    return undefined;
}

export const SandboxOpCheckedSchema = SandboxOpSchema.refine((o) => sandboxOpError(o) === undefined, { message: 'the op carries fields of another op or misses its own' });

export const SANDBOX_ERROR_CODES = ['not_found', 'not_directory', 'not_regular', 'symlink', 'is_directory', 'too_large', 'invalid_path', 'denied', 'io', 'busy'] as const;
export const SANDBOX_ENTRY_TYPES = ['file', 'dir', 'symlink', 'other'] as const;

/**
 * What the guest agent answers. ok: false carries error (the op did nothing
 * the caller can rely on). exec: the command ran (whatever its exit code).
 * read: content (base64) from offset, size of the whole file, eof. write:
 * written bytes. list: entries under path, relative to it, depth first,
 * truncated when maxEntries or the frame budget stopped it. stat: type,
 * size, mode. remove: nothing more.
 */
export const SandboxResultSchema = z.strictObject({
    ok: z.boolean(),
    error: z.strictObject({ code: z.enum(SANDBOX_ERROR_CODES), message: z.string().max(1_024) }).optional(),
    exec: z
        .strictObject({
            exitCode: z.number().int(),
            stdout: z.string().max(SANDBOX_EXEC_STDOUT_BYTES),
            stderr: z.string().max(SANDBOX_EXEC_STDERR_BYTES),
            truncated: z.boolean(),
            timedOut: z.boolean(),
            durationMs: z.number().int().min(0),
        })
        .optional(),
    content: base64.optional(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    eof: z.boolean().optional(),
    written: z.number().int().min(0).optional(),
    type: z.enum(SANDBOX_ENTRY_TYPES).optional(),
    mode: z.number().int().min(0).max(0o7777).optional(),
    entries: z
        .array(z.strictObject({ path: z.string().min(1).max(SANDBOX_PATH_MAX), type: z.enum(SANDBOX_ENTRY_TYPES), size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }))
        .max(SANDBOX_LIST_MAX_ENTRIES)
        .optional(),
    truncated: z.boolean().optional(),
});
export type SandboxResult = z.infer<typeof SandboxResultSchema>;

/** The environment a sandbox claim names on the hub and the cell: a sandbox belongs to no environment. */
export const SANDBOX_ENVIRONMENT_ID = 'sandbox';
