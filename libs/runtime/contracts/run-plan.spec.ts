import { checkPlanSubmission } from './run-plan';

const scope = { mapped: ['POST /orders'], unmappedFiles: [] };
const probe = {
    id: 'post-order-qty-zero',
    purpose: 'zero quantity is refused',
    expected: "400 with error 'item and quantity are required'",
    compare: ['status', 'json'],
    spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'POST', path: '/orders', body: '{"item":"keyboard","quantity":0}', timeoutMs: 1_000 },
};
const check = (p: unknown, assertions?: unknown) => checkPlanSubmission({ probes: [{ entryPoint: 'POST /orders', probe: p, ...(assertions === undefined ? {} : { assertions }) }] }, scope);
const declared = { ...probe, spec: { ...probe.spec, headers: { 'Content-Type': 'application/json' } } };

describe('planned HTTP request and assertion contract', () => {
    it('refuses a nonempty HTTP body without an explicit media type', () => {
        expect(check(probe).rejected).toEqual([{ reason: expect.stringContaining('Content-Type') }]);
        expect(check(probe).probes).toEqual([]);
    });

    it('accepts case-insensitive media types and preserves the exact request', () => {
        for (const headers of [{ 'content-type': 'application/json; charset=utf-8' }, { 'CONTENT-TYPE': 'text/plain', 'X-Test': 'unchanged' }]) {
            const p = { ...probe, spec: { ...probe.spec, headers } };
            const plan = check(p);
            expect(plan.rejected).toEqual([]);
            expect(plan.probes[0].probe.spec).toEqual(p.spec);
        }
    });

    it('refuses blank and ambiguous Content-Type declarations', () => {
        for (const headers of [{ 'Content-Type': ' ' }, { 'Content-Type': 'application/json', 'content-type': 'text/plain' }]) {
            expect(check({ ...probe, spec: { ...probe.spec, headers } }).rejected).toEqual([{ reason: expect.stringContaining('Content-Type') }]);
        }
    });

    it('reads legacy plans and empty requests without adding headers or assertions', () => {
        for (const body of [undefined, '']) {
            const p = { ...probe, spec: { ...probe.spec, body } };
            const plan = check(p);
            expect(plan.rejected).toEqual([]);
            expect(plan.probes[0]).not.toHaveProperty('assertions');
            expect(plan.probes[0].probe.spec).not.toHaveProperty('headers');
        }
    });

    it('retains closed assertions alongside the probe, including flat legacy submissions', () => {
        const assertions = { kind: 'http', status: 400, bodyIncludes: 'item and quantity are required' };
        const plan = check(declared, assertions);
        expect(plan.rejected).toEqual([]);
        expect(plan.probes[0]).toMatchObject({ assertions });
        expect(plan.probes[0].probe).not.toHaveProperty('assertions');
        expect(checkPlanSubmission({ probes: [{ ...declared, entryPoint: 'POST /orders', assertions }] }, scope).probes[0]).toMatchObject({ assertions });
    });

    it.each([
        { kind: 'http', status: 99 }, { kind: 'http', status: 600 }, { kind: 'http', status: 200.5 },
        { kind: 'http', status: '400' }, { kind: 'http', status: 400, bodyIncludes: '' },
        { kind: 'http', status: 400, bodyIncludes: 'x'.repeat(2_001) },
        { kind: 'http', status: 400, script: 'true' }, { kind: 'http', bodyIncludes: 'error' }, null,
    ])('refuses unsupported assertions instead of dropping them: %j', (assertions) => {
        expect(check(declared, assertions).rejected).toEqual([{ reason: expect.stringContaining('assertions') }]);
        expect(check(declared, assertions).probes).toEqual([]);
    });

    it('refuses HTTP assertions on another probe kind', () => {
        const sql = { ...probe, spec: { kind: 'sql', target: { service: 'db', port: 5432 }, query: 'SELECT 1', timeoutMs: 1_000 } };
        expect(check(sql, { kind: 'http', status: 400 }).rejected).toEqual([{ reason: expect.stringContaining('assertions') }]);
    });
});


// kr-remix#2 (2026-11-13/14, Runs 6ffa2b34, f5147f8d, 89d380fc): the planner wrote a compare field outside the closed
// list for an HTTP probe of an HTML page ("compare.1: Invalid option"), the whole probe was refused, the round's tokens
// ran out before a fix and the Run ended partly tested with no probe. What an HTTP probe compares is its floor (status,
// the JSON body field by field, an HTML page's visible text and markup), so a word outside the list adds nothing.
describe('the compare list of an HTTP probe', () => {
    const get = { id: 'about-page', purpose: 'the about page answers', expected: '200 with the about page', spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path: '/about', timeoutMs: 1_000 } };

    it('drops what is not a compare field instead of refusing the probe', () => {
        for (const extra of ['body', 'html', 'text']) {
            const plan = check({ ...get, compare: ['status', extra] });
            expect(plan.rejected).toEqual([]);
            expect(plan.probes[0].probe.compare).toEqual(['status']);
        }
        expect(check({ ...get, compare: ['body'] }).probes[0].probe.compare).toEqual(['status']);
    });

    it('still refuses a compare that is not a list, and a field outside the list on another kind', () => {
        expect(check({ ...get, compare: 'body' }).probes).toEqual([]);
        const browser = { id: 'b', purpose: 'p', expected: 'e', compare: ['pixels', 'body'], spec: { kind: 'browser', steps: [{ goto: '/' }, { screenshot: 's' }], viewport: { width: 1280, height: 720 }, timeoutMs: 60_000 } };
        expect(checkPlanSubmission({ probes: [{ entryPoint: 'POST /orders', probe: browser }] }, scope).rejected).toEqual([{ reason: expect.stringContaining('compare.1') }]);
    });
});

describe('browser exploration selectors promoted to replay', () => {
    const browser = (selector: string) => ({ ...probe, spec: { kind: 'browser', steps: [{ goto: '/' }, { click: selector }, { screenshot: 'result' }], viewport: { width: 800, height: 600 }, timeoutMs: 10_000 } });
    it.each(['@e3', ' @e1 ', ' text=Save', '  internal:role=button', '//input', 'div >> text=Save'])('refuses ephemeral selector %s in a final plan', (selector) => {
        expect(check(browser(selector)).probes).toEqual([]);
        expect(check(browser(selector)).rejected[0].reason).toContain('stable CSS selectors');
    });
    it('keeps a literal ref-like attribute value inside a stable CSS selector', () => {
        expect(check(browser('[data-testid="@e3"]')).probes).toHaveLength(1);
        expect(check(browser('e12')).probes).toHaveLength(1);
    });
});
