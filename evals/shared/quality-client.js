// The quality panel's experiments API (kodus-quality, dashboard
// app/api/experiments): an experiment sends its rows there from wherever it
// ran, and a PR's check asks which code was already measured, so nobody pays
// for the same experiment twice.
//
//   KODUS_QUALITY_URL           the panel (default https://quality.kodus.io)
//   KODUS_QUALITY_INGEST_TOKEN  the panel's EXPERIMENTS_INGEST_TOKEN: in
//                               ~/.kodus-dev/config locally, a secret in CI
const PANEL = 'https://quality.kodus.io';

const panel = () => (process.env.KODUS_QUALITY_URL || PANEL).replace(/\/+$/, '');
const token = () => process.env.KODUS_QUALITY_INGEST_TOKEN || '';

async function call(path, init = {}) {
    const res = await fetch(`${panel()}/api/experiments${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`the panel answered ${res.status}${body.error ? `: ${body.error}` : ''}`);
    return body;
}

/** Sends an experiment's rows. Never throws: says whether they arrived and why not. */
async function sendExperimentRows(rows) {
    if (!token()) return { sent: false, reason: 'KODUS_QUALITY_INGEST_TOKEN is not set (~/.kodus-dev/config)' };
    try {
        const body = await call('', { method: 'POST', body: JSON.stringify({ rows }) });
        return { sent: true, url: body.url || `${panel()}/experiments` };
    } catch (error) {
        return { sent: false, reason: String(error.message || error) };
    }
}

/** The experiments recorded for a step and branch, newest first; null when the panel cannot say. */
async function recordedExperiments(step, branch) {
    if (!token()) return null;
    try {
        const body = await call(`?step=${encodeURIComponent(step)}&branch=${encodeURIComponent(branch)}`);
        return Array.isArray(body.experiments) ? body.experiments : null;
    } catch {
        return null;
    }
}

module.exports = { sendExperimentRows, recordedExperiments, PANEL };
