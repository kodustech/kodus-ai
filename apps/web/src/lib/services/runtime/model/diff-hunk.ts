// The lines of a changed file's patch around the line a finding hit, cut
// from the patch the PR page already loads for its Files view.

export type HunkLine = {
    kind: "add" | "del" | "context";
    text: string;
    /** Line number on the PR's side; absent on a deleted line. */
    line?: number;
    hit: boolean;
};

const HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** At most `context` lines each side of `line`; undefined when the patch does not reach it. */
export const hunkAround = (
    patch: string | undefined,
    line: number | undefined,
    context = 3,
): HunkLine[] | undefined => {
    if (!patch || !line) return undefined;
    const rows: HunkLine[] = [];
    let next = 0;
    for (const raw of patch.split("\n")) {
        const header = HEADER.exec(raw);
        if (header) {
            next = Number(header[1]);
            continue;
        }
        if (next === 0 || raw.startsWith("\\")) continue;
        const sign = raw[0];
        const text = raw.slice(1);
        if (sign === "-") rows.push({ kind: "del", text, hit: false });
        else if (sign === "+")
            rows.push({ kind: "add", text, line: next, hit: next++ === line });
        else
            rows.push({
                kind: "context",
                text,
                line: next,
                hit: next++ === line,
            });
    }
    const at = rows.findIndex((r) => r.hit);
    if (at < 0) return undefined;
    return rows.slice(Math.max(0, at - context), at + context + 1);
};
