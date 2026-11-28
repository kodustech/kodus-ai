// A sentence of the Run screen with inline code (a path, a variable name),
// built from structured fields only: components render it, nothing parses it.

/** `href` (code only) is a link the model built and checked; components open it in a new tab. */
export type RichPart =
    string | { code: string; href?: string } | { strong: string };
export type RichText = RichPart[];

export const code = (value: string, href?: string): RichPart =>
    href ? { code: value, href } : { code: value };

/** A value the sentence turns on (an answer, a status): drawn bold. */
export const strong = (value: string): RichPart => ({ strong: value });

/** The plain text of a sentence, for copy, search and aria labels. */
export const plainText = (text: RichText) =>
    text
        .map((p) =>
            typeof p === "string" ? p : "code" in p ? p.code : p.strong,
        )
        .join("");

/** `a`, `a and b`, `a, b and c` — each item as code. */
export const codeList = (items: readonly string[]): RichText => {
    const parts: RichText = [];
    items.forEach((item, i) => {
        if (i > 0) parts.push(i === items.length - 1 ? " and " : ", ");
        parts.push(code(item));
    });
    return parts;
};
