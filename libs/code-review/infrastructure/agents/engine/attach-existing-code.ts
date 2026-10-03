/**
 * Attaches the code a finding points at, read from the repository at the
 * reviewed commit, as `existingCode`. Deterministic: no model call, only the
 * same `read(path, start, end)` the review's readFile tool already uses.
 *
 * Exists for the reducer (#1821): with lean finder output the candidates carry
 * only a description and a line range, and a 3-step reducer cannot read the
 * code of ten candidates before it has to decide. Findings that already carry
 * `existingCode` keep it.
 */
export type ExistingCodeReader = {
    read(path: string, start: number, end: number): Promise<string>;
};

export type AttachExistingCodeOptions = {
    /** Lines of context above and below the range. */
    context?: number;
    /** Cap on lines attached per finding, so one wide range cannot flood the prompt. */
    maxLines?: number;
};

type Locatable = {
    relevantFile?: string;
    relevantLinesStart?: number | string;
    relevantLinesEnd?: number | string;
    existingCode?: string;
};

export async function attachExistingCode<T extends Locatable>(
    findings: T[],
    reader: ExistingCodeReader,
    options: AttachExistingCodeOptions = {},
): Promise<T[]> {
    const context = options.context ?? 3;
    const maxLines = options.maxLines ?? 40;
    return Promise.all(
        findings.map(async (f) => {
            const start = Number(f.relevantLinesStart);
            if (f.existingCode || !f.relevantFile || !Number.isFinite(start) || start <= 0) {
                return f;
            }
            const endRaw = Number(f.relevantLinesEnd);
            const end = Number.isFinite(endRaw) && endRaw >= start ? endRaw : start;
            const from = Math.max(1, start - context);
            const to = Math.min(end + context, from + maxLines - 1);
            try {
                const text = await reader.read(f.relevantFile, from, to);
                if (!text) return f;
                const numbered = text
                    .split('\n')
                    .slice(0, to - from + 1)
                    .map((line, i) => `${from + i}: ${line}`)
                    .join('\n');
                return { ...f, existingCode: numbered };
            } catch {
                return f;
            }
        }),
    );
}
