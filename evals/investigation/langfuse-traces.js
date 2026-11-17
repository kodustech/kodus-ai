/**
 * Resolves the Langfuse traces a benchmark run produced, so the debugger can
 * deep-link straight to them instead of guessing a search URL.
 *
 * Two things make this less obvious than it looks:
 *
 * 1. `/api/public/traces` answers 422 "Request timed out" with no filters at
 *    all — the project has enough production traffic that an unbounded scan
 *    never finishes. `fromTimestamp` is what makes it return; everything here
 *    is scoped to the run's own window.
 * 2. A run does not produce one trace. Every model call that starts without a
 *    parent span becomes its own root trace, so a single PR shows up as several
 *    traces sharing the name `bench:<caseId>` plus a `bench:<caseId>-plan`.
 *    That is why the debugger lists them rather than linking a single one.
 */
const PAGE = 100;

function auth() {
    const pk = process.env.LANGFUSE_PUBLIC_KEY;
    const sk = process.env.LANGFUSE_SECRET_KEY;
    if (!pk || !sk) return null;
    return 'Basic ' + Buffer.from(`${pk}:${sk}`).toString('base64');
}

/** @returns {Promise<Map<string, Array<{id,name,ts,projectId}>>>} by trace name */
async function tracesByName({ since, until, environment, base }) {
    const a = auth();
    if (!a) return new Map();
    const root = (base || process.env.LANGFUSE_BASE_URL || '').replace(/\/$/, '');
    if (!root) return new Map();

    const byName = new Map();
    for (let page = 1; page <= 20; page++) {
        const q = new URLSearchParams({
            limit: String(PAGE),
            page: String(page),
            fromTimestamp: new Date(since).toISOString(),
        });
        if (until) q.set('toTimestamp', new Date(until).toISOString());
        if (environment) q.set('environment', environment);

        let data;
        try {
            const r = await fetch(`${root}/api/public/traces?${q}`, {
                headers: { Authorization: a },
            });
            if (!r.ok) {
                // A 422 here means the window is still too wide for the
                // endpoint, not that the run produced nothing — say so rather
                // than let the caller render "sem rastro".
                throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
            }
            data = (await r.json()).data || [];
        } catch (err) {
            byName.set('__error__', String(err.message || err));
            break;
        }
        for (const t of data) {
            if (!byName.has(t.name)) byName.set(t.name, []);
            byName.get(t.name).push({
                id: t.id,
                name: t.name,
                ts: t.timestamp,
                projectId: t.projectId,
            });
        }
        if (data.length < PAGE) break;
    }
    for (const [, list] of byName)
        if (Array.isArray(list)) list.sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
    return byName;
}

const traceUrl = (base, projectId, id) =>
    `${String(base).replace(/\/$/, '')}/project/${projectId}/traces/${id}`;

/** The traces list pre-filtered to one name. Langfuse encodes a filter as
 *  `column;type;key;operator;value`; an unrecognised one lands on the
 *  unfiltered list, which is why the per-trace links above it are the ones
 *  that are guaranteed to work. */
const filteredUrl = (base, projectId, name) =>
    `${String(base).replace(/\/$/, '')}/project/${projectId}/traces?filter=` +
    encodeURIComponent(`Name;stringOptions;;any of;${name}`);

module.exports = { tracesByName, traceUrl, filteredUrl };
