/**
 * The function or method that holds a line, read from the source text alone.
 *
 * It names a finding for its identity across scans (computeScanFingerprint),
 * so what matters is that the same code gives the same name every time, not
 * that it is a full parser. A line outside any recognizable declaration gets
 * no symbol, and the finding is identified by its file.
 */

const KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'with',
    'elif',
    'else',
    'match',
    'when',
    'foreach',
    'do',
    'try',
    'using',
    'lock',
    'sizeof',
    'typeof',
    'new',
    'await',
    'yield',
    'throw',
]);

const MEMBER_MODIFIERS =
    '(?:public|private|protected|static|readonly|async|override|abstract|virtual|final|synchronized|internal|sealed|extern|inline|constexpr|get|set)';
const TYPE_TOKEN = '[\\w<>[\\],.?*&:]+';

// Each pattern captures the declared name in group 1. Order matters: the
// specific forms first, the generic "type name(...) {" form last.
const FUNCTION_PATTERNS: RegExp[] = [
    // Go method: func (r *Repo) FindByID(  → Repo.FindByID
    /^\s*func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/,
    // Go / Swift / Rust / Kotlin / Python / Ruby / Elixir / PHP / JS
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*func\s+([A-Za-z_]\w*)\s*[(<]/,
    /^\s*(?:(?:override|suspend|private|public|internal|protected|inline|open)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/,
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*[?!]?)/,
    /^\s*defp?\s+([a-z_]\w*[?!]?)/,
    /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    // Class members: TS/JS methods, Java/C#/Kotlin/Scala/Dart/C++ methods.
    // A one-line signature must open its body on the same line, so a bare
    // call like `print(x)` is not read as a declaration.
    new RegExp(
        `^\\s*(?:${MEMBER_MODIFIERS}\\s+)*(?:${TYPE_TOKEN}\\s+)*?([A-Za-z_$][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\(.*\\)\\s*(?::\\s*[^{=;]+)?(?:throws\\s+[\\w., ]+)?\\s*\\{\\s*$`,
    ),
    // A signature split over lines needs a modifier to tell it from a call.
    new RegExp(
        `^\\s*(?:${MEMBER_MODIFIERS}\\s+)+(?:${TYPE_TOKEN}\\s+)*?([A-Za-z_$][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\([^;)]*$`,
    ),
];

const CLASS_PATTERN =
    /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|abstract|final|sealed|static|data|open|internal|partial)\s+)*(?:class|struct|impl|object|module|trait|interface|defmodule)\s+(?:[\w<>, ]+\s+for\s+)?([A-Za-z_][\w.:]*)/;

function indentOf(line: string): number {
    const match = line.match(/^[ \t]*/);
    return match ? match[0].replace(/\t/g, '    ').length : 0;
}

function matchFunction(line: string): string | undefined {
    for (const pattern of FUNCTION_PATTERNS) {
        const match = line.match(pattern);
        if (!match) {
            continue;
        }
        // The Go method form captures the receiver type and the name.
        const name = match[2] ? `${match[1]}.${match[2]}` : match[1];
        const bare = name.split('.').pop() ?? name;
        if (KEYWORDS.has(bare)) {
            continue;
        }
        return name;
    }
    return undefined;
}

export function enclosingSymbol(
    source: string,
    line: number,
): string | undefined {
    const lines = source.split(/\r?\n/);
    const start = Math.min(Math.max(line, 1), lines.length) - 1;
    if (start < 0) {
        return undefined;
    }

    let fn: string | undefined;
    let fnIndent = Number.POSITIVE_INFINITY;
    let i = start;

    for (; i >= 0; i--) {
        const text = lines[i];
        if (!text.trim() || indentOf(text) > indentOf(lines[start]) && i !== start) {
            continue;
        }
        const name = matchFunction(text);
        if (name) {
            fn = name;
            fnIndent = indentOf(text);
            break;
        }
    }

    if (!fn) {
        return undefined;
    }
    if (fn.includes('.')) {
        return fn;
    }

    // The class around the function, only if it encloses it (less indented).
    for (let j = i - 1; j >= 0; j--) {
        const text = lines[j];
        if (!text.trim() || indentOf(text) >= fnIndent) {
            continue;
        }
        const match = text.match(CLASS_PATTERN);
        if (match) {
            return `${match[1]}.${fn}`;
        }
        // A less-indented line that is not a class closes the search: the
        // function is top level (or nested in another function).
        if (matchFunction(text)) {
            return fn;
        }
    }

    return fn;
}
