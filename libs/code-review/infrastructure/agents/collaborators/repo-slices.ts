import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

/**
 * Deterministic repository-slice primitives.
 *
 * Extracted verbatim from call-graph.helper.ts, which was their only home and
 * kept them module-private. The Kody Rules path needs the same three moves —
 * "which symbols did this hunk change", "where else does this symbol appear"
 * and "read a window around a line" — so they live here and the call-graph
 * helper imports them back. Behavior is unchanged; call-graph.helper.spec.ts is
 * the regression guard.
 */

export const MAX_CALLGRAPH_CHARS = 6000;
const MAX_CHANGED_FILES = 15;
const MAX_FUNCTIONS_PER_FILE = 15;
export const MAX_CALLERS_PER_FUNCTION = 4;

const NOISE_NAMES = new Set([
    'if',
    'for',
    'while',
    'return',
    'new',
    'var',
    'let',
    'const',
    'get',
    'set',
    'run',
    'main',
    'init',
    'test',
    'string',
    'bool',
    'int',
    'uint',
    'error',
    'nil',
    'null',
    'void',
    'self',
    'this',
    'super',
    'type',
    'interface',
    'struct',
    'enum',
    'module',
    'package',
    'import',
    'from',
    'with',
    'True',
    'False',
    'action',
    'create',
    'delete',
    'update',
    'read',
    'write',
    'close',
    'open',
    'start',
    'stop',
    'send',
    'handle',
    'process',
    'execute',
    'apply',
    'call',
    'toString',
    'equals',
    'hashCode',
    'valueOf',
    'authenticate',
    'configure',
    'validate',
    'render',
    'display',
    'show',
    'hide',
]);

const NAME_PATTERNS: RegExp[] = [
    /func\s*\([^)]+\)\s+(\w+)\s*\(/,
    /(?:def |func |fn |function |class )\s*(\w+)/,
    /(?:public|private|protected)\s+(?:static\s+)?(?:abstract\s+)?(?:async\s+)?(?:override\s+)?[\w<>[\]]+\s+(\w+)\s*\(/,
    /export\s+(?:default\s+)?(?:function|class|const)\s+(\w+)/,
];

export const DEFINITION_PATTERN =
    /^\s*(def |func |fn |function |class |public |private |protected |interface |abstract |override |export (function|class|const))/;

export function extractContentWindow(
    content: string,
    centerLine: number,
    radius: number,
): string {
    if (!content) return '';
    const lines = content.split('\n');
    const start = Math.max(1, centerLine - radius);
    const end = Math.min(lines.length, centerLine + radius);
    return lines
        .slice(start - 1, end)
        .map((line, idx) => `${start + idx}: ${line}`)
        .join('\n');
}

export async function readSnippetWindow(
    remoteCommands: RemoteCommands,
    filePath: string,
    centerLine: number,
    radius: number,
): Promise<string> {
    const start = Math.max(1, centerLine - radius);
    const end = Math.max(start, centerLine + radius);
    try {
        const content = await remoteCommands.read(filePath, start, end);
        return content?.trim() ? content : '';
    } catch {
        return '';
    }
}

function getExtension(filePath: string): string {
    const dot = filePath.lastIndexOf('.');
    return dot >= 0 ? filePath.substring(dot) : '';
}

export function getModifiedRanges(patch?: string): Array<[number, number]> {
    if (!patch) return [];

    const ranges: Array<[number, number]> = [];
    for (const line of patch.split('\n')) {
        const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!match) continue;

        const start = parseInt(match[1], 10);
        const count = match[2] ? parseInt(match[2], 10) : 1;
        ranges.push([start, start + count - 1]);
    }

    return ranges;
}

function isInModifiedRange(
    lineNum: number,
    ranges: Array<[number, number]>,
): boolean {
    const margin = 5;
    return ranges.some(
        ([start, end]) => lineNum >= start - margin && lineNum <= end + margin,
    );
}

export function extractModifiedFunctionNames(
    changedFiles: Array<{
        filename: string;
        patch?: string;
        patchWithLinesStr?: string;
    }>,
): Array<{ name: string; file: string; line: number }> {
    const results: Array<{ name: string; file: string; line: number }> = [];

    for (const file of changedFiles.slice(0, MAX_CHANGED_FILES)) {
        if (!file.filename) continue;

        const patch = file.patchWithLinesStr || file.patch || '';
        const modifiedRanges = getModifiedRanges(patch);
        if (modifiedRanges.length === 0) continue;

        const lines = patch.split('\n');
        let currentLine = 0;

        for (const rawLine of lines) {
            const hunkMatch = rawLine.match(
                /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)/,
            );
            if (hunkMatch) {
                currentLine = parseInt(hunkMatch[1], 10) - 1;
                const hunkContext = hunkMatch[3] || '';
                if (hunkContext.trim()) {
                    let hunkName = '';
                    for (const pattern of NAME_PATTERNS) {
                        const match = hunkContext.match(pattern);
                        if (match?.[1]) {
                            hunkName = match[1];
                            break;
                        }
                    }
                    if (hunkName && hunkName.length >= 2) {
                        results.push({
                            name: hunkName,
                            file: file.filename,
                            line: currentLine + 1,
                        });
                    }
                }
                continue;
            }

            if (rawLine.startsWith('-')) continue;

            if (rawLine.startsWith('+') || !rawLine.startsWith('\\')) {
                currentLine++;
            }

            const content = rawLine.startsWith('+')
                ? rawLine.substring(1)
                : rawLine;

            if (!DEFINITION_PATTERN.test(content)) continue;
            if (!isInModifiedRange(currentLine, modifiedRanges)) continue;

            let name = '';
            for (const pattern of NAME_PATTERNS) {
                const match = content.match(pattern);
                if (match?.[1]) {
                    name = match[1];
                    break;
                }
            }

            if (
                !name ||
                name.length < 5 ||
                NOISE_NAMES.has(name) ||
                NOISE_NAMES.has(name.toLowerCase())
            ) {
                continue;
            }

            results.push({ name, file: file.filename, line: currentLine });
        }
    }

    const seen = new Set<string>();
    return results.filter((func) => {
        if (seen.has(func.name)) return false;
        seen.add(func.name);
        return true;
    });
}

export async function generateCallGraphGrep(
    remoteCommands: RemoteCommands,
    changedFiles: Array<{
        filename: string;
        patch?: string;
        patchWithLinesStr?: string;
    }>,
): Promise<string> {
    if (!remoteCommands.exec || changedFiles.length === 0) return '';

    const files = changedFiles
        .filter((file) => file.filename)
        .slice(0, MAX_CHANGED_FILES);
    if (files.length === 0) return '';

    const modifiedFunctions: Array<{
        name: string;
        file: string;
        line: number;
        ext: string;
    }> = [];

    for (const file of files) {
        const patch = file.patchWithLinesStr || file.patch || '';
        const modifiedRanges = getModifiedRanges(patch);
        if (modifiedRanges.length === 0) continue;

        const ext = getExtension(file.filename);

        try {
            const { stdout } = await remoteCommands.exec(
                `grep -nE "(^|[[:space:]])(def |func |fn |function |class |public |private |protected |async |export (function|class|const |default function))" ${shSingleQuote(file.filename)} 2>/dev/null | head -${MAX_FUNCTIONS_PER_FILE}`,
            );
            if (!stdout?.trim()) continue;

            for (const rawLine of stdout.trim().split('\n')) {
                const colonIdx = rawLine.indexOf(':');
                if (colonIdx < 0) continue;

                const lineNum = parseInt(rawLine.substring(0, colonIdx), 10);
                if (!isInModifiedRange(lineNum, modifiedRanges)) continue;

                const content = rawLine.substring(colonIdx + 1);
                let name = '';
                for (const pattern of NAME_PATTERNS) {
                    const match = content.match(pattern);
                    if (match?.[1]) {
                        name = match[1];
                        break;
                    }
                }

                if (
                    !name ||
                    name.length < 5 ||
                    NOISE_NAMES.has(name) ||
                    NOISE_NAMES.has(name.toLowerCase())
                ) {
                    continue;
                }

                modifiedFunctions.push({
                    name,
                    file: file.filename,
                    line: lineNum,
                    ext,
                });
            }
        } catch {
            continue;
        }
    }

    if (modifiedFunctions.length === 0) return '';

    const seen = new Set<string>();
    const uniqueFunctions = modifiedFunctions.filter((func) => {
        if (seen.has(func.name)) return false;
        seen.add(func.name);
        return true;
    });

    const entries: string[] = [];

    for (const func of uniqueFunctions) {
        const shortFile = func.file.split('/').slice(-2).join('/');
        const globExt = func.ext ? `--glob '*${func.ext}'` : '';

        const callers: string[] = [];
        try {
            const { stdout } = await remoteCommands.exec(
                `rg -n ${shSingleQuote(`${func.name}\\(`)} ${globExt} --glob '!*test*' --glob '!*Test*' --glob '!*spec*' --glob '!*Spec*' --glob '!*_test*' --glob '!*__tests__*' --glob '!*mock*' --glob '!*Mock*' --glob '!*.min.*' --glob '!vendor/*' . 2>/dev/null | grep -v ${shSingleQuote(func.file)} | grep -v "^Binary" | head -8`,
            );

            if (stdout?.trim()) {
                for (const callerLine of stdout.trim().split('\n')) {
                    const clean = callerLine.replace(/^\.\//, '');
                    const parts = clean.split(':');
                    if (parts.length < 3) continue;

                    const callerContent = parts.slice(2).join(':').trim();
                    if (DEFINITION_PATTERN.test(callerContent)) continue;

                    const callerFile = parts[0].split('/').slice(-2).join('/');
                    const callerLineNum = parts[1];
                    const trimmedContent = callerContent.substring(0, 80);

                    callers.push(
                        `  ← ${callerFile}:${callerLineNum}  ${trimmedContent}`,
                    );
                    if (callers.length >= MAX_CALLERS_PER_FUNCTION) break;
                }
            }
        } catch {
            // best effort
        }

        if (callers.length > 0) {
            entries.push(
                `${func.name} (${shortFile}:${func.line})\n${callers.join('\n')}`,
            );
        }
    }

    if (entries.length === 0) return '';

    let result =
        'Changed functions and their production callers:\n\n' +
        entries.join('\n\n');

    if (result.length > MAX_CALLGRAPH_CHARS) {
        result = result.substring(0, MAX_CALLGRAPH_CHARS) + '\n... (truncated)';
    }

    return result;
}
