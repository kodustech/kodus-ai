// The closed step list (BrowserStepSchema in libs/runtime/probe/probe.schema.ts,
// S-31) as the runner plays it. The probe never reaches page script: every
// step is one Playwright call on a locator or the keyboard, and a step this
// file does not know is refused, not guessed. The cell checks the job before
// it starts the container (internal/browser); the runner checks it again.

export const STEP_KINDS = ['goto', 'click', 'fill', 'select', 'press', 'waitFor', 'expectText', 'getAttribute', 'screenshot'];

export const MAX_STEPS = 100;
export const MAX_SCREENSHOTS = 10;
/** One step waits at most this long for its element or its text. */
export const STEP_TIMEOUT_MS = 5_000;
/** A navigation waits at most this long for the load event. */
export const GOTO_TIMEOUT_MS = 15_000;
const VALUE_MAX = 512;

// A path on the app, as the observer accepts it: one leading slash, never
// `//` or a backslash, and nothing that reads the code instead of the
// behavior (observer.go sideDetectingPath).
const SERVICE_PATH = /^\/([^/\\][^\\]*)?$/;
const SIDE_DETECTING = /(^|\/)(\.git|\.hg|\.svn|\.env[^/;]*|\.kodus|proc|sys)(\/|;|$)/i;
// Playwright's internal selector engines are not part of the closed list.
const INTERNAL_SELECTOR = /(^|>>\s*)internal:/;
const KEY = /^[A-Za-z0-9+]{1,64}$/;

export class JobError extends Error {}

const isString = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

/** The kind of one step object: its only key, which must be a known kind. */
export function kindOf(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new JobError('a step is an object');
    const keys = Object.keys(step);
    if (keys.length !== 1 || !STEP_KINDS.includes(keys[0])) throw new JobError(`unknown step ${JSON.stringify(keys)}`);
    return keys[0];
}

function checkStep(step) {
    const kind = kindOf(step);
    const v = step[kind];
    const pair = (a, b) => Array.isArray(v) && v.length === 2 && isString(v[0], 1_024) && typeof v[1] === 'string' && v[1].length <= b && (a === 0 || v[1].length >= a);
    switch (kind) {
        case 'goto':
            if (typeof v !== 'string' || v.length > 2_048 || !SERVICE_PATH.test(v)) throw new JobError('goto takes a path on the app');
            if (SIDE_DETECTING.test(v.split(/[?#]/)[0])) throw new JobError('goto reads the code, not the behavior');
            return;
        case 'click':
        case 'waitFor':
            if (!isString(v, 1_024)) throw new JobError(`${kind} takes a selector`);
            return;
        case 'fill':
        case 'expectText':
            if (!pair(0, 8_192)) throw new JobError(`${kind} takes [selector, text]`);
            return;
        case 'select':
            if (!pair(0, 1_024)) throw new JobError('select takes [selector, value]');
            return;
        case 'getAttribute':
            if (!pair(1, 128)) throw new JobError('getAttribute takes [selector, name]');
            return;
        case 'press':
            if (!isString(v, 64) || !KEY.test(v)) throw new JobError('press takes a key name');
            return;
        case 'screenshot':
            if (!isString(v, 128)) throw new JobError('screenshot takes a name');
            return;
    }
}

/** The job the cell sends on stdin, checked; throws JobError. */
export function checkJob(job) {
    if (!job || typeof job !== 'object') throw new JobError('job is an object');
    const { steps, viewport, origin, timeoutMs, clock, evidence = 'full' } = job;
    if (evidence !== 'lean' && evidence !== 'full') throw new JobError('evidence is lean or full');
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw new JobError('1 to 100 steps');
    steps.forEach(checkStep);
    if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) throw new JobError('viewport');
    if (viewport.width < 200 || viewport.width > 4_096 || viewport.height < 200 || viewport.height > 4_096) throw new JobError('viewport out of bounds');
    let url;
    try {
        url = new URL(origin);
    } catch {
        throw new JobError('origin is a URL');
    }
    if (url.protocol !== 'http:' || url.origin !== origin) throw new JobError('origin is http://host:port');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new JobError('timeoutMs in [1000, 60000]');
    if (clock !== undefined && (typeof clock !== 'string' || Number.isNaN(Date.parse(clock)))) throw new JobError('clock is a date-time');
    return { steps, viewport, origin, timeoutMs, clock, evidence };
}

const clip = (s) => (s.length > VALUE_MAX ? s.slice(0, VALUE_MAX) : s);

function errorCode(e) {
    if (e instanceof JobError) return 'refused';
    const name = e?.name ?? '';
    const msg = String(e?.message ?? '');
    if (name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) return 'timeout';
    if (/net::ERR_|Navigation|navigat/i.test(msg)) return 'navigation';
    return 'error';
}

/**
 * Plays the steps on one page. `page` is the Playwright page; `shoot(name)`
 * takes a screenshot and returns its index, or undefined past the limit;
 * `now()` is ms since the runner's t0; `deadline` the ms the run may last.
 * Stops at the first step that fails, takes a screenshot of it, and marks
 * the rest skipped. Never evaluates anything from the probe in the page.
 */
export async function playSteps({ steps, origin, page, shoot, now, deadline, checkActive = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const out = [];
    let failed = false;
    const left = () => Math.max(0, deadline - now());
    for (let index = 0; index < steps.length; index++) {
        checkActive();
        const step = steps[index];
        const kind = kindOf(step);
        const v = step[kind];
        const startMs = now();
        if (failed || left() === 0) {
            out.push({ index, kind, ok: false, startMs, endMs: startMs, error: 'skipped' });
            continue;
        }
        const timeout = Math.max(1, Math.min(kind === 'goto' ? GOTO_TIMEOUT_MS : STEP_TIMEOUT_MS, left()));
        const res = { index, kind, ok: true, startMs, endMs: startMs };
        try {
            const sel = Array.isArray(v) ? v[0] : v;
            if (kind !== 'goto' && kind !== 'press' && kind !== 'screenshot' && INTERNAL_SELECTOR.test(sel)) throw new JobError('internal selectors are not allowed');
            const loc = () => page.locator(sel).first();
            switch (kind) {
                case 'goto':
                    await page.goto(origin + v, { waitUntil: 'load', timeout });
                    break;
                case 'click':
                    await loc().click({ timeout });
                    break;
                case 'fill':
                    await loc().fill(v[1], { timeout });
                    break;
                case 'select':
                    await loc().selectOption(v[1], { timeout });
                    break;
                case 'press':
                    await page.keyboard.press(v);
                    break;
                case 'waitFor':
                    await loc().waitFor({ state: 'visible', timeout });
                    break;
                case 'expectText': {
                    try {
                        await loc().waitFor({ state: 'attached', timeout });
                    } catch (e) {
                        res.error = errorCode(e) === 'timeout' ? 'not_found' : errorCode(e);
                        throw e;
                    }
                    // The text may still be arriving: read it until it holds or the step's time is up.
                    // A read cut short by that time keeps the last text read: it is a mismatch, not a timeout.
                    const until = now() + timeout;
                    let text;
                    for (;;) {
                        try {
                            text = (await loc().innerText({ timeout: Math.max(100, until - now()) })) ?? '';
                        } catch (e) {
                            if (text === undefined || errorCode(e) !== 'timeout') throw e;
                            break;
                        }
                        if (text.includes(v[1]) || now() >= until) break;
                        await sleep(100);
                    }
                    res.value = clip(text);
                    if (!text.includes(v[1])) {
                        res.ok = false;
                        res.error = 'mismatch';
                    }
                    break;
                }
                case 'getAttribute': {
                    try {
                        await loc().waitFor({ state: 'attached', timeout });
                    } catch (e) {
                        res.error = errorCode(e) === 'timeout' ? 'not_found' : errorCode(e);
                        throw e;
                    }
                    const value = await loc().getAttribute(v[1], { timeout });
                    if (value !== null) res.value = clip(value);
                    break;
                }
                case 'screenshot': {
                    const n = await shoot(v);
                    if (n !== undefined) res.screenshot = n;
                    break;
                }
            }
        } catch (e) {
            res.ok = false;
            res.error ??= errorCode(e);
            if (kind === 'click' || kind === 'fill' || kind === 'select' || kind === 'waitFor') {
                if (res.error === 'timeout') res.error = 'not_found';
            }
        }
        // Observer policy/cancellation stays outside the app-error catch.
        checkActive();
        if (!res.ok) {
            failed = true;
            // One look at the screen where it went wrong.
            if (res.screenshot === undefined) {
                try {
                    const n = await shoot(`failed-step-${index}`);
                    if (n !== undefined) res.screenshot = n;
                } catch {
                    // a page that cannot be shot still has its outcome
                }
            }
        }
        res.endMs = Math.max(startMs, now());
        out.push(res);
    }
    return out;
}
