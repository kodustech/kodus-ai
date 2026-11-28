// Entry-point coverage from what the observer sent (S-32), never from the
// label the agent wrote. A probe covers `POST /orders/:orderId` only when the
// observer's request log on both sides shows a POST to a path of that shape.

export interface ObservedRequest {
    method: string;
    route: string;
}

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;

/** A method that any request matches: Nest `@All`, Express `.all`, a Next route that exports no method. */
export const ANY_METHOD = 'ALL';

/** The route shape of a concrete path (same rule as the cell's observer.Route). */
export function routeShapeOf(path: string): string {
    const p = path.split('?')[0].split('#')[0];
    if (!p) return '/';
    return p
        .split('/')
        .map((s) => (NUMERIC.test(s) || UUID.test(s) || HEX.test(s) ? ':id' : s))
        .join('/');
}

/** `*`, `*slug`, `[...slug]`, `[[...slug]]`, `{*path}`: a segment that takes one or more of the remaining segments. */
const isCatchAll = (seg: string) => /^\*[\w-]*$/.test(seg) || /^\[{1,2}\.\.\.[^/[\]]+\]{1,2}$/.test(seg) || /^\{\*[^/{}]+\}$/.test(seg);
/** `:id`, `{id}`, `[id]`: a segment of a route declaration that takes any one value. */
const isParam = (seg: string) => /^:[\w-]+\??$/.test(seg) || /^\{[^/{}*]+\}$/.test(seg) || /^\[[^/[\].]+\]$/.test(seg);

const segments = (route: string) => route.replace(/\/+$/, '').split('/').filter((s, i) => i === 0 || s !== '');

/**
 * A route declared below a mount the extractor cannot see (Express `app.use('/server', router)`, Nest
 * `setGlobalPrefix('api')`) is served with up to this many leading segments it does not declare.
 */
const MAX_MOUNT_SEGMENTS = 2;

/** want against got from got's `offset`: segment by segment, a param takes any one, a last catch-all one or more. */
function matchesFrom(want: string[], got: string[], offset: number): boolean {
    for (let i = 1; i < want.length; i++) {
        const w = want[i];
        const j = i + offset;
        if (isCatchAll(w) && i === want.length - 1) return got.length > j;
        if (j >= got.length) return false;
        if (!(isParam(w) || w === got[j])) return false;
    }
    return want.length + offset === got.length;
}

/**
 * Whether one observed request hits the declared route `METHOD /path`. Segment by segment; a param takes any one
 * segment. The request may carry up to MAX_MOUNT_SEGMENTS leading segments the declaration does not (its mount),
 * when the declaration names at least one literal segment: `GET /` or `GET /:id` never match by their tail.
 */
export function requestMatchesEntryPoint(entryPointId: string, req: ObservedRequest): boolean {
    const m = /^([A-Z]+)\s+(\/\S*)$/.exec(entryPointId);
    if (!m) return false;
    const [, method, route] = m;
    if (method !== ANY_METHOD && method !== req.method.toUpperCase()) return false;
    const want = segments(route);
    const got = segments(req.route);
    if (matchesFrom(want, got, 0)) return true;
    if (!want.slice(1).some((w) => w !== '' && !isParam(w) && !isCatchAll(w))) return false;
    for (let offset = 1; offset <= MAX_MOUNT_SEGMENTS; offset++) if (matchesFrom(want, got, offset)) return true;
    return false;
}

/**
 * The entry point a probe really covered. The agent's label wins only when the
 * observer's log backs it on both sides; otherwise the first diff entry point
 * the log does back; otherwise 'unmapped', which settles nothing and leaves
 * the diff's entry points uncovered (partly tested, never success).
 */
export function coveredEntryPoint(
    label: string,
    entryPointIds: readonly string[],
    sides: { base: readonly ObservedRequest[]; pr: readonly ObservedRequest[] },
): string {
    const backed = (id: string) => sides.base.some((r) => requestMatchesEntryPoint(id, r)) && sides.pr.some((r) => requestMatchesEntryPoint(id, r));
    if (entryPointIds.includes(label) && backed(label)) return label;
    return entryPointIds.find(backed) ?? 'unmapped';
}
