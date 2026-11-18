import { z } from 'zod';

import { RECIPE_FILE_PATHS } from './enums';

// The Dockerfiles and compose files Kody writes next to an authored recipe
// (docs RECIPE-AGENT-TEST-PLAN): the bounds every hop carries them under, the
// product's answer, the setup record, a Run request and claim.acquire, so a
// file the API accepted is one the cell accepts. The API's authored-files
// policy decides what such a file may say; this only bounds where it lives
// and how much of it travels. The Go cell mirrors these rules
// (apps/runtime-cell/internal/protocol/authored_files.go).

export const AUTHORED_FILES_LIMITS = {
    /** Files one recipe may carry. */
    files: 4,
    /** UTF-8 bytes of one file. */
    fileBytes: 16 * 1024,
    /** UTF-8 bytes of all of them. */
    totalBytes: 48 * 1024,
} as const;

/**
 * One file directly under .kodus/, its name starting with a letter or a
 * digit: never `.` or `..`, never a nested path. RE2-compatible (the Go cell
 * compiles it from the JSON Schema).
 */
export const AUTHORED_FILE_PATH_PATTERN = '^\\.kodus/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';

export const AuthoredFileSchema = z.strictObject({
    path: z.string().regex(new RegExp(AUTHORED_FILE_PATH_PATTERN)),
    content: z.string().max(AUTHORED_FILES_LIMITS.fileBytes),
});
export type AuthoredFile = z.infer<typeof AuthoredFileSchema>;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Why a list of authored files is refused beyond its schema, or null: a file
 * or the whole list over its bytes, a path twice, or a recipe path (the cell
 * boots its recipe from the claim, never from an authored file).
 */
export function authoredFilesProblem(files: readonly AuthoredFile[]): string | null {
    const seen = new Set<string>();
    let total = 0;
    for (const f of files) {
        if ((RECIPE_FILE_PATHS as readonly string[]).includes(f.path)) return `${f.path} is a recipe path, not a build file`;
        if (seen.has(f.path)) return `${f.path} is listed twice`;
        seen.add(f.path);
        const bytes = utf8Bytes(f.content);
        if (bytes > AUTHORED_FILES_LIMITS.fileBytes) return `${f.path} is larger than ${AUTHORED_FILES_LIMITS.fileBytes} bytes`;
        total += bytes;
    }
    if (total > AUTHORED_FILES_LIMITS.totalBytes) return `the files are larger than ${AUTHORED_FILES_LIMITS.totalBytes} bytes together`;
    return null;
}

export const AuthoredFilesSchema = z
    .array(AuthoredFileSchema)
    .min(1)
    .max(AUTHORED_FILES_LIMITS.files)
    .superRefine((files, ctx) => {
        const problem = authoredFilesProblem(files);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });
