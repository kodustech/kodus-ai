/**
 * `content` in a code fence it cannot close: one backtick longer than the
 * longest run inside it. Untrusted text (repository code, model output) in a
 * fixed ``` fence ends the fence at its own ``` line, and what follows is
 * read as part of the prompt.
 */
export function fenced(content: string, info = ''): string {
    const longest = Math.max(
        0,
        ...(content.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${info}\n${content}\n${fence}`;
}
