// The quality panel's experiments API (kodus-quality, dashboard
// app/api/experiments): an experiment sends its rows there from wherever it
// ran, and a PR's check asks which code was already measured, so nobody pays
// for the same experiment twice.
//
//   KODUS_QUALITY_URL           the panel's origin (default https://quality.kodus.io):
//                               https, or http on localhost; no path, query or credentials
//   KODUS_QUALITY_INGEST_TOKEN  the panel's EXPERIMENTS_INGEST_TOKEN: in
//                               ~/.kodus-dev/config locally, a secret in CI
//
// The secret never travels: each request carries an HMAC-SHA256 of its method,
// path with query, a timestamp and its body's hash (x-kodus-timestamp,
// x-kodus-signature), which the panel recomputes.
const crypto = require('crypto');

const PANEL = 'https://quality.kodus.io';

/** The panel's origin, refused unless it is a bare https origin (or http on localhost). */
function panelOrigin() {
    const raw = process.env.KODUS_QUALITY_URL || PANEL;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`KODUS_QUALITY_URL is not a URL: ${raw}`);
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const plain = !url.username && !url.password && url.pathname.replace(/\/+$/, '') === '' && !url.search && !url.hash;
    if (!plain || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
        throw new Error(`KODUS_QUALITY_URL must be an https origin (or http on localhost), without path, query or credentials: ${raw}`);
    }
    return url.origin;
}

const secret = () => process.env.KODUS_QUALITY_INGEST_TOKEN || '';

/** The headers that sign one request. */
function signature(method, pathWithQuery, body, key = secret(), now = Date.now()) {
    const ts = String(Math.floor(now / 1000));
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const mac = crypto.createHmac('sha256', key).update(`${method}\n${pathWithQuery}\n${ts}\n${bodyHash}`).digest('hex');
    return { 'x-kodus-timestamp': ts, 'x-kodus-signature': `sha256=${mac}` };
}

async function call(method, query = '', payload = null) {
    const origin = panelOrigin();
    const path = `/api/experiments${query}`;
    const body = payload === null ? '' : JSON.stringify(payload);
    const res = await fetch(`${origin}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...signature(method, path, body) },
        ...(method === 'GET' ? {} : { body }),
        signal: AbortSignal.timeout(30_000),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`the panel answered ${res.status}${answer.error ? `: ${answer.error}` : ''}`);
    return { answer, origin };
}

/** Sends an experiment's rows. Never throws: says whether they arrived and why not. */
async function sendExperimentRows(rows) {
    if (!secret()) return { sent: false, reason: 'KODUS_QUALITY_INGEST_TOKEN is not set (~/.kodus-dev/config)' };
    try {
        const { origin } = await call('POST', '', { rows });
        return { sent: true, url: `${origin}/experiments` };
    } catch (error) {
        return { sent: false, reason: String(error.message || error) };
    }
}

/** The experiments recorded for a step and branch, newest first; null when the panel cannot say. */
async function recordedExperiments(step, branch) {
    if (!secret()) return null;
    try {
        const { answer } = await call('GET', `?step=${encodeURIComponent(step)}&branch=${encodeURIComponent(branch)}`);
        return Array.isArray(answer.experiments) ? answer.experiments : null;
    } catch {
        return null;
    }
}

/** The panel's experiments page, from the same origin the client talks to. */
function experimentsPage() {
    try {
        return `${panelOrigin()}/experiments`;
    } catch {
        return `${PANEL}/experiments`;
    }
}

module.exports = { sendExperimentRows, recordedExperiments, experimentsPage, signature, panelOrigin, PANEL };
