export interface UnifiedDiffFile {
    filename: string;
    previous_filename?: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    /** From the first `@@` on, the shape a host's per-file `patch` has. */
    patch: string;
    additions: number;
    deletions: number;
}

/** Splits a multi-file `git diff` into one entry per file. */
export function splitUnifiedDiff(diff: string): UnifiedDiffFile[] {
    if (!diff?.trim()) return [];

    return diff
        .split(/(?=^diff --git )/m)
        .map((section) => {
            if (!section.startsWith('diff --git ')) return null;

            const hunkStart = section.search(/^@@ /m);
            const head =
                hunkStart === -1 ? section : section.slice(0, hunkStart);
            const patch =
                hunkStart === -1 ? '' : section.slice(hunkStart).trimEnd();

            const filename = newPath(head);
            if (!filename) return null;
            const renamedFrom = extendedHeaderPath(head, 'rename from');

            let additions = 0;
            let deletions = 0;
            for (const line of patch.split('\n')) {
                if (line.startsWith('+')) additions++;
                else if (line.startsWith('-')) deletions++;
            }

            const file: UnifiedDiffFile = {
                filename,
                status: /^new file mode/m.test(head)
                    ? 'added'
                    : /^deleted file mode/m.test(head)
                      ? 'removed'
                      : renamedFrom
                        ? 'renamed'
                        : 'modified',
                patch,
                additions,
                deletions,
            };
            if (renamedFrom) file.previous_filename = renamedFrom;
            return file;
        })
        .filter((file): file is UnifiedDiffFile => !!file);
}

/**
 * The file's path after the change, as a host lists it. The `---`/`+++`
 * lines and the extended headers carry one path each, so they are read
 * first; the `diff --git a/X b/Y` line is ambiguous when a path contains
 * " b/" and is only the last resort (a mode-only or binary change).
 */
function newPath(head: string): string | null {
    const plus = markerPath(head, '+++');
    if (plus && plus !== '/dev/null') return stripPrefix(plus, 'b/');
    if (plus === '/dev/null') {
        const minus = markerPath(head, '---');
        if (minus && minus !== '/dev/null') return stripPrefix(minus, 'a/');
    }
    return (
        extendedHeaderPath(head, 'rename to') ??
        extendedHeaderPath(head, 'copy to') ??
        gitHeaderNewPath(head)
    );
}

const MARKER_LINE = {
    '+++': /^\+\+\+ (.+)$/m,
    '---': /^--- (.+)$/m,
} as const;

const EXTENDED_HEADER_LINE = {
    'rename from': /^rename from (.+)$/m,
    'rename to': /^rename to (.+)$/m,
    'copy to': /^copy to (.+)$/m,
} as const;

function markerPath(
    head: string,
    marker: keyof typeof MARKER_LINE,
): string | null {
    const raw = head.match(MARKER_LINE[marker])?.[1];
    // git ends the name with a tab when it contains a space
    return raw === undefined ? null : unquote(raw.replace(/\t$/, ''));
}

function extendedHeaderPath(
    head: string,
    label: keyof typeof EXTENDED_HEADER_LINE,
): string | undefined {
    const raw = head.match(EXTENDED_HEADER_LINE[label])?.[1];
    return raw === undefined ? undefined : unquote(raw);
}

function gitHeaderNewPath(head: string): string | null {
    const rest = head.match(/^diff --git (.+)$/m)?.[1];
    if (!rest) return null;

    // Quoted (non-ASCII or special characters): "a/…" "b/…"
    const quoted = rest.match(
        /^(?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/,
    );
    if (quoted) return stripPrefix(unquote(quoted[1]), 'b/');

    // Same path on both sides: "a/P b/P", split in the middle so a path
    // containing " b/" is not cut at the wrong place.
    const half = (rest.length - 5) / 2;
    if (
        Number.isInteger(half) &&
        rest.startsWith('a/') &&
        rest.slice(2 + half, 5 + half) === ' b/' &&
        rest.slice(2, 2 + half) === rest.slice(5 + half)
    ) {
        return rest.slice(5 + half);
    }

    const lastB = rest.lastIndexOf(' b/');
    return lastB === -1 ? null : rest.slice(lastB + 3);
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const C_ESCAPES: Record<string, number> = {
    'a': 7,
    'b': 8,
    't': 9,
    'n': 10,
    'v': 11,
    'f': 12,
    'r': 13,
    '"': 34,
    '\\': 92,
};

/**
 * git quotes a path holding non-ASCII or special characters as a C string:
 * `"src/caf\303\251.ts"`. The octal escapes are UTF-8 bytes.
 */
function unquote(raw: string): string {
    if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) {
        return raw;
    }
    const body = raw.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== '\\') {
            bytes.push(...Buffer.from(ch, 'utf8'));
            continue;
        }
        const octal = body.slice(i + 1, i + 4);
        const next = body[i + 1];
        if (/^[0-7]{3}$/.test(octal)) {
            bytes.push(parseInt(octal, 8));
            i += 3;
        } else if (next !== undefined && next in C_ESCAPES) {
            bytes.push(C_ESCAPES[next]);
            i += 1;
        } else {
            bytes.push(92);
        }
    }
    return Buffer.from(bytes).toString('utf8');
}
