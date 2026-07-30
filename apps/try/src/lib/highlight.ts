// Tiny regex-based TS/JS highlighter. Not a full parser — just enough to
// give LLM-suggested code blocks the same visual rhythm as a real editor.
// Colors map to the Kodus palette so the syntax stays on-brand.

export type Token = {
    kind:
        | "plain"
        | "keyword"
        | "type"
        | "string"
        | "comment"
        | "number"
        | "punct"
        | "ident"
        | "fn";
    text: string;
};

const KEYWORDS = new Set([
    "function",
    "const",
    "let",
    "var",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "default",
    "new",
    "throw",
    "try",
    "catch",
    "finally",
    "import",
    "export",
    "from",
    "as",
    "async",
    "await",
    "class",
    "extends",
    "implements",
    "interface",
    "type",
    "enum",
    "public",
    "private",
    "protected",
    "readonly",
    "static",
    "this",
    "super",
    "typeof",
    "instanceof",
    "in",
    "of",
    "void",
    "yield",
    "delete",
    "null",
    "undefined",
    "true",
    "false",
]);

const TYPES = new Set([
    "string",
    "number",
    "boolean",
    "any",
    "unknown",
    "never",
    "object",
    "symbol",
    "bigint",
    "Array",
    "Record",
    "Map",
    "Set",
    "Promise",
    "Partial",
    "Required",
    "Readonly",
    "Pick",
    "Omit",
    "Exclude",
    "Extract",
    "ReturnType",
    "Parameters",
    "Awaited",
    "Date",
    "RegExp",
    "Error",
]);

export function tokenize(input: string): Token[] {
    const out: Token[] = [];
    const src = input;
    let i = 0;

    const push = (kind: Token["kind"], text: string) => {
        if (!text) return;
        out.push({ kind, text });
    };

    while (i < src.length) {
        const c = src[i];

        // Line comment
        if (c === "/" && src[i + 1] === "/") {
            let j = i;
            while (j < src.length && src[j] !== "\n") j++;
            push("comment", src.slice(i, j));
            i = j;
            continue;
        }

        // Block comment
        if (c === "/" && src[i + 1] === "*") {
            let j = i + 2;
            while (j < src.length && !(src[j] === "*" && src[j + 1] === "/"))
                j++;
            j = Math.min(j + 2, src.length);
            push("comment", src.slice(i, j));
            i = j;
            continue;
        }

        // String literal — ', ", or `
        if (c === "'" || c === '"' || c === "`") {
            const quote = c;
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === "\\") {
                    j += 2;
                    continue;
                }
                if (src[j] === quote) {
                    j++;
                    break;
                }
                if (src[j] === "\n" && quote !== "`") break;
                j++;
            }
            push("string", src.slice(i, j));
            i = j;
            continue;
        }

        // Number
        if (/\d/.test(c)) {
            let j = i;
            while (j < src.length && /[\d._a-fA-FxX]/.test(src[j])) j++;
            push("number", src.slice(i, j));
            i = j;
            continue;
        }

        // Identifier / keyword / type
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
            const word = src.slice(i, j);
            // Lookahead: if followed by "(" it's likely a function call.
            let k = j;
            while (k < src.length && /\s/.test(src[k])) k++;
            const isCall = src[k] === "(";

            if (KEYWORDS.has(word)) {
                push("keyword", word);
            } else if (TYPES.has(word)) {
                push("type", word);
            } else if (isCall) {
                push("fn", word);
            } else {
                push("ident", word);
            }
            i = j;
            continue;
        }

        // Whitespace
        if (/\s/.test(c)) {
            let j = i;
            while (j < src.length && /\s/.test(src[j])) j++;
            push("plain", src.slice(i, j));
            i = j;
            continue;
        }

        // Punctuation / operator
        push("punct", c);
        i++;
    }

    return out;
}

/**
 * Inline-style map. We can't use Tailwind class names here — they're
 * resolved by `TOKEN_STYLE[token.kind]` at render time, which Tailwind's
 * JIT scanner doesn't pick up, so the classes get purged and the code
 * renders monochrome. Inline style values are immune to that.
 */
export const TOKEN_STYLE: Record<Token["kind"], React.CSSProperties> = {
    plain: { color: "var(--text)" },
    keyword: { color: "var(--secondary)" },
    type: { color: "var(--accent)" },
    string: { color: "var(--green)" },
    comment: { color: "var(--text-dim)", fontStyle: "italic" },
    number: { color: "var(--orange)" },
    punct: { color: "var(--text-muted)" },
    ident: { color: "var(--text)" },
    fn: { color: "var(--info)" },
};
