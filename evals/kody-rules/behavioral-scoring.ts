/**
 * Pure parsing + scoring core for behavioral-shipped.js (#1449).
 *
 * Extracted and unit-tested on its own because this is the code that PRODUCES
 * the recall number the per-model coverage gate trusts. A bug here (a regex
 * that fails to unwrap the model's JSON, or an off-by-one in the ±tolerance
 * match) would silently report a wrong pass/fail — so the gate's own logic is
 * pinned by behavioral-scoring.spec.ts.
 */

export interface Site {
    file: string;
    line: number;
}

/** Strip markdown fences / prose and parse the model's JSON into a violations
 *  array. Returns [] on anything unparseable (a shard that yields no JSON is a
 *  miss, not a crash). */
export function parseViolations(text: string | undefined | null): any[] {
    if (!text) return [];
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    try {
        const o = JSON.parse(t);
        return Array.isArray(o.violations) ? o.violations : [];
    } catch {
        return [];
    }
}

/**
 * Occurrence-recall scoring for one case: how many ground-truth sites a set of
 * flagged sites covers (within ±lineTol lines, same file), and how many flags
 * landed on a real site (line precision numerator).
 */
export function scoreCase(
    sites: Site[],
    flags: Site[],
    lineTol = 2,
): { caught: number; onTarget: number } {
    const near = (a: Site, b: Site) =>
        a.file === b.file && Math.abs(a.line - b.line) <= lineTol;
    const caught = sites.filter((g) => flags.some((x) => near(x, g))).length;
    const onTarget = flags.filter((x) => sites.some((g) => near(x, g))).length;
    return { caught, onTarget };
}

export const normalizePath = (p: unknown): string =>
    String(p || '')
        .replace(/^\/+/, '')
        .trim();
