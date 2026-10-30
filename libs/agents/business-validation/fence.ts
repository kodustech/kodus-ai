/**
 * A labeled data block for a prompt, whose text can't close it early: a
 * `</label>` inside it, spaced or not (`</ label >`), is escaped, so what
 * follows stays data.
 */
export function fence(label: string, text: string): string {
    const safe = text.replace(
        new RegExp(`<\\s*/?\\s*${label}\\s*>`, 'gi'),
        (tag) => `&lt;${tag.slice(1)}`,
    );
    return `<${label}>\n${safe}\n</${label}>`;
}
