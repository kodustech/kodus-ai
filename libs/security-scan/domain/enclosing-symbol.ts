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
    // Closures and blocks a function holds, never the function itself.
    'func',
    'go',
    'defer',
    'synchronized',
]);

/** Longer lines are generated or minified: no declaration is read on them. */
const MAX_DECLARATION_CHARS = 2000;

/** A decorator or attribute line belongs to the declaration below it. */
const DECORATOR = /^\s*(?:@[A-Za-z_][\w.]*|\[[A-Za-z_][\w.]*(?:\(.*\))?\])/;

/** `new Foo<T>() {`: an anonymous class, not a declaration. */
const ANONYMOUS_CLASS = /\bnew\s+[A-Za-z_][\w.]*\s*(?:<[^>]*>)?\s*\(/;

const MEMBER_MODIFIERS =
    '(?:public|private|protected|static|readonly|async|override|abstract|virtual|final|synchronized|internal|sealed|extern|inline|constexpr|get|set)';
const TYPE_TOKEN = '[\\w<>[\\],.?*&:]+';

// Each pattern captures the declared name in group 1. Order matters: the
// specific forms first, the generic "type name(...) {" form last.
const FUNCTION_PATTERNS: RegExp[] = [
    // Go method: func (r *Repo) FindByID(  → Repo.FindByID; Repo[T] too.
    /^\s*func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*[([]/,
    // Go / Swift / Rust / Kotlin / Python / Ruby / Elixir / PHP / JS
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*func\s+([A-Za-z_]\w*)\s*[(<[]/,
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
    // (A one-line signature whose brace opens on the next line, Allman
    // style, is read by allmanDeclaration.)
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
    if (line.length > MAX_DECLARATION_CHARS || ANONYMOUS_CLASS.test(line)) {
        return undefined;
    }
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

/** A complete signature with no brace, whose body opens on the next code line. */
const ALLMAN_SIGNATURE = new RegExp(
    `^\\s*(?:${MEMBER_MODIFIERS}\\s+)*(?:${TYPE_TOKEN}\\s+)*?([A-Za-z_$][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\(.*\\)\\s*(?::\\s*[^{=;]+)?(?:throws\\s+[\\w., ]+)?\\s*$`,
);

function allmanDeclaration(code: string[], i: number): string | undefined {
    const line = code[i];
    if (line.length > MAX_DECLARATION_CHARS || ANONYMOUS_CLASS.test(line)) {
        return undefined;
    }
    const match = line.match(ALLMAN_SIGNATURE);
    if (!match || KEYWORDS.has(match[1])) {
        return undefined;
    }
    for (let j = i + 1; j < code.length; j++) {
        const next = code[j].trim();
        if (next) {
            return next.startsWith('{') ? match[1] : undefined;
        }
    }
    return undefined;
}

function declarationAt(code: string[], i: number): string | undefined {
    return matchFunction(code[i]) ?? allmanDeclaration(code, i);
}

/**
 * The source with comments and string literals blanked out, line by line, so
 * a declaration written inside a block comment or a multi-line string is not
 * read as code and a brace in a string never counts. Lengths and indentation
 * are kept.
 */
export function codeLines(source: string): string[] {
    const out: string[] = [];
    let line = '';
    // What the text being read is inside, if anything.
    let inside: '/*' | '"""' | "'''" | '`' | '"' | "'" | null = null;
    // A backslash ended the line inside a string: the string goes on.
    let continued = false;

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '\n') {
            // A plain quote never spans lines unless the line ends in a
            // backslash; an unterminated one ends here.
            if ((inside === '"' || inside === "'") && !continued) {
                inside = null;
            }
            continued = false;
            out.push(line.replace(/\r$/, ''));
            line = '';
            continue;
        }
        if (inside) {
            const closer = inside === '/*' ? '*/' : inside;
            if (ch === '\\' && inside !== '/*') {
                if (source[i + 1] === '\n') {
                    // Left for the line break above, which ends the line.
                    line += ' ';
                    continued = true;
                    continue;
                }
                continued = source[i + 1] === '\r';
                line += '  ';
                i++;
                continue;
            }
            if (source.startsWith(closer, i)) {
                line += ' '.repeat(closer.length);
                i += closer.length - 1;
                inside = null;
            } else {
                line += ch === '\t' ? '\t' : ' ';
            }
            continue;
        }
        if (source.startsWith('/*', i)) {
            inside = '/*';
            line += '  ';
            i++;
            continue;
        }
        if (source.startsWith('//', i)) {
            const end = source.indexOf('\n', i);
            const rest = (end < 0 ? source.length : end) - i;
            line += ' '.repeat(rest);
            i += rest - 1;
            continue;
        }
        if (
            ch === '#' &&
            (!line.trim() || /\s$/.test(line)) &&
            source[i + 1] !== '['
        ) {
            // A comment (Python, Ruby, shell), at the line's start or after
            // code (`def handle(self):  # entry`); a C directive is no
            // declaration either. Rust's `#[attr]` is code.
            const end = source.indexOf('\n', i);
            const rest = (end < 0 ? source.length : end) - i;
            line += ' '.repeat(rest);
            i += rest - 1;
            continue;
        }
        const triple = source.startsWith('"""', i)
            ? '"""'
            : source.startsWith("'''", i)
              ? "'''"
              : null;
        if (triple) {
            inside = triple;
            line += '   ';
            i += 2;
            continue;
        }
        if (
            ch === '`' ||
            ch === '"' ||
            (ch === "'" && !/\w/.test(line.slice(-1)))
        ) {
            // A quote right after a word character is an apostrophe or a
            // Rust lifetime, not a string.
            inside = ch as '`' | '"' | "'";
            line += ' ';
            continue;
        }
        line += ch;
    }
    out.push(line.replace(/\r$/, ''));
    return out;
}

/**
 * Whether the declaration on `decl` still encloses `target`: its braces have
 * not closed before it, or (an indentation language) no line in between sits
 * at or left of the declaration.
 */
function encloses(code: string[], decl: number, target: number): boolean {
    if (decl === target) {
        return true;
    }
    const head = code[decl].trimEnd();
    if (head.endsWith(':') && !head.includes('{')) {
        // Python-style: the body is the lines indented under it.
        const declIndent = indentOf(code[decl]);
        for (let i = decl + 1; i <= target; i++) {
            if (code[i].trim() && indentOf(code[i]) <= declIndent) {
                return false;
            }
        }
        return true;
    }
    // Braces inside the signature's parentheses (a destructured parameter,
    // a default `{}`) are not the body's.
    let depth = 0;
    let parens = 0;
    let opened = false;
    for (let i = decl; i < target; i++) {
        for (const ch of code[i]) {
            if (ch === '(') {
                parens++;
            } else if (ch === ')') {
                parens = Math.max(0, parens - 1);
            } else if (parens > 0) {
                continue;
            } else if (ch === '{') {
                depth++;
                opened = true;
            } else if (ch === '}' && --depth <= 0 && opened) {
                return false;
            }
        }
    }
    return true;
}

export function enclosingSymbol(
    source: string,
    line: number,
): string | undefined {
    const lines = codeLines(source);
    // codeLines returns at least one line, so this is a valid index.
    let start = Math.min(Math.max(line, 1), lines.length) - 1;
    // A decorator or attribute names the declaration it sits on.
    if (DECORATOR.test(lines[start])) {
        let j = start;
        while (
            j + 1 < lines.length &&
            (DECORATOR.test(lines[j]) || !lines[j].trim())
        ) {
            j++;
        }
        start = j;
    }
    // A blank line has no indent of its own: it takes the code above it.
    while (start > 0 && !lines[start].trim()) {
        start--;
    }

    let fn: string | undefined;
    let fnIndent = Number.POSITIVE_INFINITY;
    let i = start;

    for (; i >= 0; i--) {
        const text = lines[i];
        if (
            !text.trim() ||
            (indentOf(text) > indentOf(lines[start]) && i !== start)
        ) {
            continue;
        }
        const name = declarationAt(lines, i);
        if (name && encloses(lines, i, start)) {
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
        if (text.length > MAX_DECLARATION_CHARS) {
            continue;
        }
        const match = text.match(CLASS_PATTERN);
        if (match) {
            // `ns::Class` keeps its colons; a Python `class Handler:` sheds
            // the one that opens its body.
            return `${match[1].replace(/:+$/, '')}.${fn}`;
        }
        // A less-indented line that is not a class closes the search: the
        // function is top level (or nested in another function).
        if (declarationAt(lines, j)) {
            return fn;
        }
    }

    return fn;
}
