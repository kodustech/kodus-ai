// Verifier-verdict CAPTURE — turn production Langfuse traces into a corpus
// run.js can replay, and print how often each delivery shape occurs.
//
//   node evals/verifier-verdict/capture.js --days 10 --limit 200
//   node evals/verifier-verdict/capture.js --trace <id>          # one trace
//   node evals/verifier-verdict/capture.js --out DIR             # where to write
//
// Exit: 0 ok / 2 infra (missing keys / Langfuse error).
//
// WHY this is not fixtures.json: kodus-ai is PUBLIC and these payloads are
// customer source. The corpus is written OUTSIDE the repo by default and must
// never be committed; fixtures.json carries the same SHAPES rewritten neutrally.
//
// The verifier is identified by its SYSTEM PROMPT, not by observation name: the
// per-finding name verifier.agent.ts builds (`agent/verify:file#line`) does not
// reach the trace — every observation is a generic `invoke_agent <model>`. That
// is a separate observability gap; until it is fixed this signature is the only
// way to tell a verify run from a finder run.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '../..');
const VERIFIER_SIG = /You are a surgical code review verifier/i;

function cfg(key) {
    if (process.env[key]) return process.env[key];
    for (const p of [
        path.join(os.homedir(), '.kodus-dev', 'config'),
        path.join(ROOT, '.env'),
    ]) {
        try {
            for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                const m = line.match(
                    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)`),
                );
                if (m)
                    return m[1]
                        .replace(/\s+#.*$/, '')
                        .trim()
                        .replace(/^["']|["']$/g, '');
            }
        } catch {}
    }
    return null;
}

const BASE = (
    cfg('LANGFUSE_BASE_URL') || 'https://us.cloud.langfuse.com'
).replace(/\/$/, '');
const PK = cfg('LANGFUSE_PUBLIC_KEY');
const SK = cfg('LANGFUSE_SECRET_KEY');
if (!PK || !SK) {
    console.error(
        'INFRA: missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (env, ~/.kodus-dev/config, or .env)',
    );
    process.exit(2);
}
const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');
const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
};

async function lf(pathname, params) {
    const u = new URL(BASE + pathname);
    for (const [k, v] of Object.entries(params || {}))
        u.searchParams.set(k, String(v));
    const r = await fetch(u, { headers: { Authorization: AUTH } });
    if (!r.ok)
        throw new Error(`langfuse ${r.status} on ${u.pathname}${u.search}`);
    return r.json();
}

const S = (v) =>
    typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);

/** The model's final assistant TEXT — what extractVerdict's text path reads. */
function finalAssistantText(output) {
    let arr = output;
    if (typeof arr === 'string') {
        try {
            arr = JSON.parse(arr);
        } catch {
            return arr;
        }
    }
    if (!Array.isArray(arr)) return S(output);
    for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (m?.role && m.role !== 'assistant') continue;
        const parts = m?.parts || m?.content;
        if (typeof parts === 'string' && parts.trim()) return parts;
        if (Array.isArray(parts)) {
            const txt = parts
                .filter((p) => p?.type === 'text')
                .map((p) =>
                    typeof p.content === 'string'
                        ? p.content
                        : typeof p.text === 'string'
                          ? p.text
                          : '',
                )
                .join('\n');
            if (txt.trim()) return txt;
        }
    }
    return '';
}

function rowsFromTrace(t) {
    const obs = t.observations || [];
    const model = obs.map((o) => o.model).find(Boolean) || 'unknown';
    const out = S(t.output);
    const verifiers = obs.filter(
        (o) => o.type === 'AGENT' && VERIFIER_SIG.test(S(o.input)),
    );
    const submitTools = obs.filter(
        (o) => o.type === 'TOOL' && /submitVerdict/i.test(o.name || ''),
    );
    const submitParents = new Set(
        submitTools.map((o) => o.parentObservationId),
    );
    const gensByParent = {};
    for (const o of obs)
        if (o.type === 'GENERATION')
            (gensByParent[o.parentObservationId] ||= []).push(o);

    return verifiers.map((v) => {
        // The tool sits under a `step N` span under the AGENT — two hops.
        const sub = new Set([v.id]);
        for (let hop = 0; hop < 2; hop++)
            for (const o of obs)
                if (sub.has(o.parentObservationId)) sub.add(o.id);
        const calledVerdictTool = [...submitParents].some((p) => sub.has(p));
        // The tool ARGS are the verdict — run.js needs them to judge a tool row.
        const tool = submitTools.find((o) => sub.has(o.parentObservationId));
        const toolPayload = tool
            ? (tool.input?.args ?? tool.input ?? null)
            : null;
        let text = finalAssistantText(v.output);
        if (!text.trim()) {
            const g = (gensByParent[v.id] || []).sort(
                (a, b) => new Date(a.startTime) - new Date(b.startTime),
            );
            if (g.length) text = finalAssistantText(g[g.length - 1].output);
        }
        return {
            id: `${t.id}:${v.id.slice(0, 8)}`,
            traceId: t.id,
            at: t.timestamp,
            model,
            calledVerdictTool,
            toolPayload,
            // Verbatim: run.js replays it through the production extractor.
            text,
            // What the trace itself recorded, for the parseMode before/after.
            traceParseMode:
                [
                    ...new Set(
                        [...out.matchAll(/"parseMode"\s*:\s*"([^"]+)"/g)].map(
                            (m) => m[1],
                        ),
                    ),
                ].join('|') || null,
            traceDroppedByVerifier: Number(
                (out.match(/"droppedByVerifier"\s*:\s*(\d+)/) || [])[1] ?? -1,
            ),
        };
    });
}

const KEEP_FALSE =
    /"(?:keep|shouldKeep|should_keep|decision|verdict)"\s*:\s*(?:false|"no")/i;

(async () => {
    const one = arg('trace');
    let traces = [];
    if (one) {
        traces = [await lf(`/api/public/traces/${one}`)];
    } else {
        const days = Number(arg('days', 10));
        const limit = Number(arg('limit', 200));
        const fromTimestamp = new Date(Date.now() - days * 864e5).toISOString();
        const ids = [];
        for (let page = 1; ids.length < limit; page++) {
            const r = await lf('/api/public/traces', {
                name: 'kodus-generalist-review-agent',
                fromTimestamp,
                limit: 50,
                page,
            });
            const d = r.data || [];
            if (!d.length) break;
            for (const t of d) if (ids.length < limit) ids.push(t.id);
        }
        process.stderr.write(`fetching ${ids.length} traces…\n`);
        let failed = 0;
        for (const id of ids) {
            try {
                traces.push(await lf(`/api/public/traces/${id}`));
            } catch {
                failed++;
            }
        }
        // A silent drop here would understate every count below.
        if (failed)
            process.stderr.write(
                `WARN ${failed}/${ids.length} trace fetches failed — counts are a floor\n`,
            );
    }

    const rows = traces.flatMap(rowsFromTrace);
    const outDir = arg('out', path.join(os.tmpdir(), 'kodus-verifier-verdict'));
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'corpus.json');
    fs.writeFileSync(
        file,
        JSON.stringify(
            {
                capturedAt: new Date().toISOString(),
                traces: traces.length,
                rows,
            },
            null,
            2,
        ),
    );

    const mode = (r) =>
        r.calledVerdictTool
            ? 'tool'
            : KEEP_FALSE.test(r.text) || /"keep"/i.test(r.text)
              ? 'text'
              : r.text.trim()
                ? 'text?'
                : 'none';
    const agg = {};
    for (const r of rows) {
        const a = (agg[r.model] ||= {
            'tool': 0,
            'text': 0,
            'text?': 0,
            'none': 0,
            'refutations': 0,
        });
        a[mode(r)]++;
        if (!r.calledVerdictTool && KEEP_FALSE.test(r.text)) a.refutations++;
    }
    console.log(
        `\ntraces ${traces.length} | verifier runs ${rows.length}\ncorpus: ${file}\n`,
    );
    console.log('model'.padEnd(34), 'tool  text  none  refutations-in-text');
    const T = { 'tool': 0, 'text': 0, 'text?': 0, 'none': 0, 'refutations': 0 };
    for (const [k, a] of Object.entries(agg).sort(
        (x, y) => y[1].tool + y[1].text - (x[1].tool + x[1].text),
    )) {
        console.log(
            k.slice(0, 34).padEnd(34),
            String(a.tool).padEnd(5),
            String(a.text + a['text?']).padEnd(5),
            String(a.none).padEnd(5),
            a.refutations,
        );
        for (const f of Object.keys(T)) T[f] += a[f];
    }
    console.log('-'.repeat(72));
    console.log(
        'TOTAL'.padEnd(34),
        String(T.tool).padEnd(5),
        String(T.text + T['text?']).padEnd(5),
        String(T.none).padEnd(5),
        T.refutations,
    );
    console.log(
        `\nReplay the corpus through the production extractor:\n  node evals/verifier-verdict/run.js --corpus ${file}`,
    );
    // Explicit: a runner that just returns can hang CI on open handles.
    process.exit(0);
})().catch((e) => {
    console.error(`INFRA: ${e.message}`);
    process.exit(2);
});
