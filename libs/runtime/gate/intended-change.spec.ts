import type { Probe, ProbeResult } from '@libs/runtime/probe/probe.schema';

import { decideProbe, type GateDecision, type GateStep } from './gate';
import { browserStepKindsOf, changeBlocksOf, decideIntendedChange } from './intended-change';
import { normalizeFields } from './probe-fields';

// A difference the PR's diff spells out is the change it means, not a
// regression; a literal the diff does not touch that changes stays one.

const IMAGE = 'img-1';
let n = 0;
const step = (side: 'base' | 'pr', round: number, fields: Record<string, string>): GateStep => ({
    stepId: `s${++n}`,
    probeId: 'p',
    side,
    round,
    executor: 'observer',
    imageId: IMAGE,
    transport: 'ok',
    vmHealth: 'ok',
    timedOut: false,
    fields,
    expectedHolds: side === 'base',
});
/** Two rounds per side with the same fields, decided by the gate first, as the replay does. */
const rounds = (base: Record<string, string>, pr: Record<string, string>) => [step('base', 1, base), step('base', 2, base), step('pr', 1, pr), step('pr', 2, pr)];
const gate = (steps: GateStep[]) => decideProbe(steps, { pinnedImageId: IMAGE }) as Extract<GateDecision, { kind: 'verdict' }>;

// demo-nextjs#2: the PR rewords one feature line of the home page.
const PAGE = 'examples/with-docker/app/page.tsx';
const PAGE_PATCH = [
    '@@ -32,7 +32,7 @@ export default function Home() {',
    '             </p>',
    '             <ul className="list-disc list-inside space-y-2 text-zinc-600">',
    '               <li>Multi-stage Docker build for optimal image size</li>',
    '-              <li>Production-ready configuration</li>',
    '+              <li>Production configuration, ready to deploy</li>',
    '               <li>Security best practices (non-root user)</li>',
    '               <li>BuildKit cache mounts for faster builds</li>',
    '             </ul>',
].join('\n');
const LIST = (line: string) =>
    ['Multi-stage Docker build for optimal image size', line, 'Security best practices (non-root user)', 'BuildKit cache mounts for faster builds'].join('\n');
const MAIN_LIST = LIST('Production-ready configuration');
const PR_LIST = LIST('Production configuration, ready to deploy');
const PAGE_STEPS = browserStepKindsOf([{ goto: '/' }, { waitFor: '#main-heading' }, { expectText: ['ul.list-disc', 'x'] }, { screenshot: 'features' }]);
const pageDiff = [{ path: PAGE, patch: PAGE_PATCH }];
/** Every file of a diff as one the probed route is declared in: the case each test is about is elsewhere. */
const filesOf = (diff: ReadonlyArray<{ path: string }>) => diff.map((f) => f.path);

describe('decideIntendedChange', () => {
    it("demo-nextjs#2: main's text asserted, the PR's reworded line read: the PR's intended change, with both values and the line", () => {
        const steps = rounds(
            { steps: 'ok,ok,ok,ok', 'step.2.value': MAIN_LIST, 'pixels.3': 'same' },
            { steps: 'ok,ok,fail:mismatch,fail:skipped', 'step.2.value': PR_LIST },
        );
        const decision = gate(steps);
        expect(decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change', differingFields: ['steps', 'step.2.value'] });

        const d = decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE], browserStepKinds: PAGE_STEPS });

        expect(d).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change', differingFields: ['steps', 'step.2.value'] });
        expect(d.intendedChange).toEqual([
            { field: 'step.2.value', base: 'Production-ready configuration', pr: 'Production configuration, ready to deploy', file: PAGE, line: 35 },
        ]);
        expect(d.reason).toBe(`changed as the PR intended: "Production-ready configuration" on main, "Production configuration, ready to deploy" on the PR, as ${PAGE}:35 changes it`);
    });

    it("the PR's new text asserted (main fails the step) is the same intended change", () => {
        const steps = rounds(
            { steps: 'ok,ok,fail:mismatch,fail:skipped', 'step.2.value': MAIN_LIST },
            { steps: 'ok,ok,ok,ok', 'step.2.value': PR_LIST, 'pixels.3': 'same' },
        );
        const d = decideIntendedChange(gate(steps), steps, { diff: pageDiff, reachableFiles: [PAGE], browserStepKinds: PAGE_STEPS });
        expect(d).toMatchObject({ verdict: 'finding', intendedChange: [{ base: 'Production-ready configuration', pr: 'Production configuration, ready to deploy', line: 35 }] });
    });

    it('a text both sides show, asserted: the steps pass, the read text and the pixels differ, and the diff explains it', () => {
        const steps = [
            step('base', 1, { steps: 'ok,ok,ok,ok', 'step.2.value': MAIN_LIST, 'pixels.3': 'same' }),
            step('base', 2, { steps: 'ok,ok,ok,ok', 'step.2.value': MAIN_LIST, 'pixels.3': 'same' }),
            step('pr', 1, { steps: 'ok,ok,ok,ok', 'step.2.value': PR_LIST, 'pixels.3': 'changed' }),
            step('pr', 2, { steps: 'ok,ok,ok,ok', 'step.2.value': PR_LIST, 'pixels.3': 'changed' }),
        ].map((s) => ({ ...s, expectedHolds: true }));
        const decision = gate(steps);
        expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['step.2.value', 'pixels.3'] });
        expect(decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE], browserStepKinds: PAGE_STEPS }).intendedChange).toHaveLength(1);
    });

    it('a JSON field the diff renames, its value unchanged, is the intended change', () => {
        const diff = [
            {
                path: 'src/users/users.controller.ts',
                patch: ['@@ -10,4 +10,4 @@ export class UsersController {', '     return {', '       id: user.id,', '-      userName: user.name,', '+      username: user.name,', '     };'].join('\n'),
            },
        ];
        const steps = rounds({ status: '200', 'json.id': '7', 'json.userName': '"ana"' }, { status: '200', 'json.id': '7', 'json.username': '"ana"' });
        const decision = gate(steps);
        expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['json.userName', 'json.username'] });

        const d = decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) });

        expect(d.intendedChange).toEqual([{ field: 'json.userName', base: 'userName', pr: 'username', file: 'src/users/users.controller.ts', line: 12 }]);
    });

    it('a JSON value the diff changes is the intended change, also when the new literal holds the old one', () => {
        const diff = [{ path: 'src/orders.ts', patch: ['@@ -3,3 +3,3 @@', ' if (!items.length) {', '-  throw new BadRequestException("cart is empty");', '+  throw new BadRequestException("your cart is empty");', ' }'].join('\n') }];
        const steps = rounds({ status: '400', 'json.error': '"cart is empty"' }, { status: '400', 'json.error': '"your cart is empty"' });
        expect(decideIntendedChange(gate(steps), steps, { diff, reachableFiles: filesOf(diff) }).intendedChange).toEqual([
            { field: 'json.error', base: 'cart is empty', pr: 'your cart is empty', file: 'src/orders.ts', line: 4 },
        ]);
    });

    it('a one-word JSON value is the intended change when the changed line names its key', () => {
        const diff = [{ path: 'src/account.ts', patch: ['@@ -1,1 +1,1 @@', '-  return { state: "active" };', '+  return { state: "disabled" };'].join('\n') }];
        const steps = rounds({ 'json.state': '"active"' }, { 'json.state': '"disabled"' });
        expect(decideIntendedChange(gate(steps), steps, { diff, reachableFiles: filesOf(diff) }).intendedChange).toEqual([{ field: 'json.state', base: 'active', pr: 'disabled', file: 'src/account.ts', line: 1 }]);
    });

    describe('stays a regression', () => {
        it('a page line the diff does not touch changes', () => {
            const steps = rounds(
                { steps: 'ok,ok,ok,ok', 'step.2.value': MAIN_LIST },
                { steps: 'ok,ok,ok,ok', 'step.2.value': MAIN_LIST.replace('Security best practices (non-root user)', 'Security best practices') },
            ).map((s) => ({ ...s, expectedHolds: true }));
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE], browserStepKinds: PAGE_STEPS })).toBe(decision);
        });

        it('a JSON value the diff does not touch changes, beside one it does', () => {
            const diff = [{ path: 'src/a.ts', patch: ['@@ -1,2 +1,2 @@', '-  label: "Old",', '+  label: "New",', '   total: sum(items),'].join('\n') }];
            const steps = rounds({ 'json.label': '"Old"', 'json.total': '20' }, { 'json.label': '"New"', 'json.total': '0' });
            const decision = gate(steps);
            expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['json.label', 'json.total'] });
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it("the diff removes main's literal but the PR answers something it does not add (shop: 400 → 500)", () => {
            const diff = [{ path: 'src/orders.ts', patch: ['@@ -8,2 +8,2 @@', '-        if (!body.items.length) throw new BadRequestException("cart is empty");', '+        return this.orders.create(body);'].join('\n') }];
            const steps = rounds({ status: '400', 'json.error': '"cart is empty"' }, { status: '500', 'json.error': '"internal"' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it("a field compared by digest (an HTML body) is never explained", () => {
            const steps = rounds({ status: '200', json: 'not_json', 'body.sha256': 'a' }, { status: '200', json: 'not_json', 'body.sha256': 'b' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE] })).toBe(decision);
        });

        it('a renamed key whose value changes too', () => {
            const diff = [{ path: 'u.ts', patch: ['@@ -1,1 +1,1 @@', '-  userName: user.name,', '+  username: user.login,'].join('\n') }];
            const steps = rounds({ 'json.userName': '"ana"' }, { 'json.username': '"ana-1"' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it("main's literal is still added back by the diff (a moved line, not a change)", () => {
            const diff = [{ path: 'a.ts', patch: ['@@ -1,1 +1,2 @@', '-  status: "active",', '+  status: "active",', '+  next: "enabled",'].join('\n') }];
            const steps = rounds({ 'json.status': '"active"' }, { 'json.status': '"enabled"' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        // A literal the diff changes somewhere else is not the probed behavior: a
        // coincidental number, boolean or short word never explains a regression.
        it('a broken route (200 → 500, ok true → false) beside an unrelated config file that changes 200 → 500 and true → false', () => {
            const diff = [{ path: 'src/config.ts', patch: ['@@ -1,2 +1,2 @@', '-export const MAX_ITEMS = 200;', '-export const strict = true;', '+export const MAX_ITEMS = 500;', '+export const strict = false;'].join('\n') }];
            const steps = rounds({ status: '200', 'json.ok': 'true' }, { status: '500', 'json.ok': 'false' });
            const decision = gate(steps);
            expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['status', 'json.ok'] });
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it('a status code is never explained, even by a line that sets it', () => {
            const diff = [{ path: 'src/orders.ts', patch: ['@@ -1,1 +1,1 @@', '-    res.status(200).json(order);', '+    res.status(201).json(order);'].join('\n') }];
            const steps = rounds({ status: '200' }, { status: '201' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it('a JSON number is never explained, even with its key on the line', () => {
            const diff = [{ path: 'src/cart.ts', patch: ['@@ -1,1 +1,1 @@', '-  total: 20,', '+  total: 0,'].join('\n') }];
            const steps = rounds({ 'json.total': '20' }, { 'json.total': '0' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it('a one-word JSON value changed on a line that does not name its key', () => {
            const diff = [{ path: 'src/flags.ts', patch: ['@@ -1,1 +1,1 @@', '-const mode = "active";', '+const mode = "disabled";'].join('\n') }];
            const steps = rounds({ 'json.state': '"active"' }, { 'json.state': '"disabled"' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it('a literal changed only in a comment', () => {
            const diff = [{ path: 'src/orders.ts', patch: ['@@ -1,1 +1,1 @@', '-  // error: "cart is empty"', '+  // error: "your cart is empty"'].join('\n') }];
            const steps = rounds({ status: '400', 'json.error': '"cart is empty"' }, { status: '400', 'json.error': '"your cart is empty"' });
            const decision = gate(steps);
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        it('a literal changed only in a test file or a README', () => {
            const patch = ['@@ -1,1 +1,1 @@', '-  expect(body.error).toBe("cart is empty");', '+  expect(body.error).toBe("your cart is empty");'].join('\n');
            const steps = rounds({ status: '400', 'json.error': '"cart is empty"' }, { status: '400', 'json.error': '"your cart is empty"' });
            const decision = gate(steps);
            for (const path of ['src/orders.spec.ts', 'test/orders.e2e.ts', 'src/__tests__/orders.ts', 'README.md']) {
                expect(decideIntendedChange(decision, steps, { diff: [{ path, patch }], reachableFiles: [path] })).toBe(decision);
            }
        });

        it('a page number that changes, beside a diff that changes the same number elsewhere', () => {
            const diff = [{ path: 'src/limits.ts', patch: ['@@ -1,1 +1,1 @@', '-export const PAGE = 20;', '+export const PAGE = 0;'].join('\n') }];
            const steps = rounds({ steps: 'ok,ok', 'step.1.value': 'Total: 20' }, { steps: 'ok,ok', 'step.1.value': 'Total: 0' }).map((s) => ({ ...s, expectedHolds: true }));
            const decision = gate(steps);
            expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['step.1.value'] });
            expect(decideIntendedChange(decision, steps, { diff, reachableFiles: filesOf(diff) })).toBe(decision);
        });

        // v-core N2: the diff is the PR author's text. Each decoy below swaps the
        // probed JSON value where it reaches nothing the route runs.
        describe('a decoy the route never runs (v-core N2)', () => {
            const steps = rounds({ status: '200', 'json.role': '"guest"' }, { status: '200', 'json.role': '"admin"' });
            const decision = gate(steps);
            const SWAP = ['@@ -1,3 +1,3 @@', ' const user = {', '-  role: "guest",', '+  role: "admin",', ' };'].join('\n');
            const ROUTE = 'src/me.controller.ts';

            it('in a file the probed route is not declared in', () => {
                const diff = [{ path: 'src/unused.ts', patch: SWAP }];
                expect(decideIntendedChange(decision, steps, { diff, reachableFiles: [ROUTE] })).toBe(decision);
            });

            it('in a doc or a text file, with or without a route', () => {
                for (const path of ['docs/guide.md', 'notes.txt', 'docs/api.rst']) {
                    expect(decideIntendedChange(decision, steps, { diff: [{ path, patch: SWAP }], reachableFiles: [ROUTE] })).toBe(decision);
                }
            });

            it('inside a block comment whose inner lines carry no star', () => {
                const patch = ['@@ -1,5 +1,5 @@', ' /*', '-  role: "guest",', '+  role: "admin",', ' */', ' export const x = 1;'].join('\n');
                expect(decideIntendedChange(decision, steps, { diff: [{ path: ROUTE, patch }], reachableFiles: [ROUTE] })).toBe(decision);
            });

            it('inside a block comment opened above the hunk, read from the file', () => {
                const content = ['/*', 'notes', 'more notes', 'and more', '  role: "admin",', '*/', 'export const x = 1;'].join('\n');
                const patch = ['@@ -3,4 +3,4 @@', ' more notes', ' and more', '-  role: "guest",', '+  role: "admin",', ' */'].join('\n');
                expect(decideIntendedChange(decision, steps, { diff: [{ path: ROUTE, patch, content }], reachableFiles: [ROUTE] })).toBe(decision);
            });

            it('inside a Python docstring', () => {
                const patch = ['@@ -1,5 +1,5 @@', ' def me():', '     """', '-    role: "guest",', '+    role: "admin",', '     """'].join('\n');
                expect(decideIntendedChange(decision, steps, { diff: [{ path: 'app/me.py', patch }], reachableFiles: ['app/me.py'] })).toBe(decision);
            });

            it('after the comment opens on a code row', () => {
                const patch = ['@@ -1,1 +1,1 @@', '-  const x = 1; // role: "guest"', '+  const x = 1; // role: "admin"'].join('\n');
                expect(decideIntendedChange(decision, steps, { diff: [{ path: ROUTE, patch }], reachableFiles: [ROUTE] })).toBe(decision);
            });

            it('with the key only inside another string', () => {
                const patch = ['@@ -1,1 +1,1 @@', '-  log("role: guest", "guest");', '+  log("role: admin", "admin");'].join('\n');
                expect(decideIntendedChange(decision, steps, { diff: [{ path: ROUTE, patch }], reachableFiles: [ROUTE] })).toBe(decision);
            });

            it('while the same swap in the route\'s own file, as code, is the intended change', () => {
                expect(decideIntendedChange(decision, steps, { diff: [{ path: ROUTE, patch: SWAP }], reachableFiles: [ROUTE] }).intendedChange).toEqual([
                    { field: 'json.role', base: 'guest', pr: 'admin', file: ROUTE, line: 2 },
                ]);
                const python = ['@@ -1,1 +1,1 @@', '-    return {"role": "guest"}', '+    return {"role": "admin"}'].join('\n');
                expect(decideIntendedChange(decision, steps, { diff: [{ path: 'app/me.py', patch: python }], reachableFiles: ['app/me.py'] }).intendedChange).toHaveLength(1);
            });
        });

        it('a finding that is not a behavior change (the machine lost on the PR)', () => {
            const decision: GateDecision = { kind: 'verdict', verdict: 'finding', findingKind: 'pr_destabilizes_machine', reason: 'r', differingFields: ['status'], maskedFields: [] };
            expect(decideIntendedChange(decision, [], { diff: pageDiff, reachableFiles: [PAGE] })).toBe(decision);
        });
    });

    it('a change that made one side skip an asserting step after it is inconclusive, not a regression and not settled', () => {
        const kinds = browserStepKindsOf([{ goto: '/' }, { expectText: ['ul.list-disc', 'x'] }, { click: '#deploy' }, { expectText: ['#status', 'Deployed'] }]);
        const steps = rounds(
            { steps: 'ok,ok,ok,ok', 'step.1.value': MAIN_LIST, 'step.3.value': 'Deployed' },
            { steps: 'ok,fail:mismatch,fail:skipped,fail:skipped', 'step.1.value': PR_LIST },
        );
        const decision = gate(steps);
        expect(decision.verdict).toBe('finding');

        const d = decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE], browserStepKinds: kinds });

        expect(d).toMatchObject({ verdict: 'inconclusive', intendedChange: [{ field: 'step.1.value', line: 35 }] });
        expect(d).not.toHaveProperty('findingKind');
        expect(d.reason).toContain('skipped steps 3, 4 after it');
    });
});

describe('changeBlocksOf', () => {
    it('pairs the removed and added rows between context rows, with the PR line of each added row', () => {
        expect(changeBlocksOf(pageDiff)).toEqual([
            { file: PAGE, removed: ['              <li>Production-ready configuration</li>'], added: [{ text: '              <li>Production configuration, ready to deploy</li>', line: 35 }] },
        ]);
    });

    it('a removed row that starts with dashes is a removed row, and a pure addition is no block', () => {
        const patch = ['@@ -1,2 +1,3 @@', '--- old flag', '+-- new flag', ' x', '+added'].join('\n');
        expect(changeBlocksOf([{ path: 'flags.txt', patch }])).toEqual([{ file: 'flags.txt', removed: ['-- old flag'], added: [{ text: '-- new flag', line: 1 }] }]);
    });

    it('comment rows, test files and project documents make no block; the line numbers after a comment row stay right', () => {
        const sql = ['@@ -1,2 +1,3 @@', '--- old comment', '+-- new comment', ' x', '+added'].join('\n');
        expect(changeBlocksOf([{ path: 'q.sql', patch: sql }])).toEqual([]);
        const ts = ['@@ -1,2 +1,3 @@', '-  label: "Old name",', '+  // renamed', '+  label: "New name",'].join('\n');
        expect(changeBlocksOf([{ path: 'src/a.ts', patch: ts }])).toEqual([{ file: 'src/a.ts', removed: ['  label: "Old name",'], added: [{ text: '  label: "New name",', line: 2 }] }]);
        expect(changeBlocksOf([{ path: 'src/a.spec.ts', patch: ts }, { path: 'CHANGELOG.md', patch: ts }])).toEqual([]);
    });
});

describe('an HTTP probe of an HTML page: compared by its visible text and its markup (planner-eval.md option C)', () => {
    const probe = {
        id: 'home',
        origin: 'agent',
        purpose: 'p',
        expected: '200',
        compare: ['status'],
        spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path: '/' },
    } as Probe;
    /** demo-nextjs's home page under `next dev`: chunk names carry the build's hashes, an inline script the request's id. */
    const page = (line: string, opts: { build?: string; requestId?: string; listClass?: string } = {}) => {
        const build = opts.build ?? 'd4005f96';
        const chunks = [`app_layout_tsx_${build}._.js`, `app_page_tsx_${build}._.js`, `62cdd_next_dist_client_components_builtin_global-error_${build}.js`];
        return [
            '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>',
            ...(build === 'd4005f96' ? chunks : [...chunks].reverse()).map((c) => `<script src="/_next/static/chunks/${c}" async=""></script>`),
            '<title>Next.js Docker Example</title></head><body><main><h1>Next.js Docker Example</h1>',
            `<ul class="${opts.listClass ?? 'list-disc list-inside space-y-2 text-zinc-600'}">`,
            '<li>Multi-stage Docker build for optimal image size</li>',
            `<li>${line}</li>`,
            '<li>Security best practices (non-root user)</li><li>BuildKit cache mounts for faster builds</li></ul></main>',
            `<script>self.__next_r="${opts.requestId ?? 'r1'}"</script></body></html>`,
        ].join('');
    };
    /** A round that answered 200 as the probe expects, with the fields production derives from the page. */
    const answered = (side: 'base' | 'pr', round: number, body: string): GateStep => ({
        ...step(
            side,
            round,
            normalizeFields(probe, {
                stepId: '00000000-0000-4000-8000-000000000001',
                executor: 'observer',
                imageId: IMAGE,
                http: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body },
                transport: 'ok',
            } as ProbeResult),
        ),
        expectedHolds: true,
    });
    const MAIN = 'Production-ready configuration';
    const PR = 'Production configuration, ready to deploy';

    it("demo-nextjs#2 over HTTP: the reworded line the diff spells out is the PR's intended change, on another build and other requests", () => {
        const steps = [
            answered('base', 1, page(MAIN, { requestId: 'a' })),
            answered('base', 2, page(MAIN, { requestId: 'b' })),
            answered('pr', 1, page(PR, { build: '0c0ffee1', requestId: 'c' })),
            answered('pr', 2, page(PR, { build: '0c0ffee1', requestId: 'd' })),
        ];
        const decision = gate(steps);
        expect(decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change', differingFields: ['html.text'] });

        const d = decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE] });

        expect(d.intendedChange).toEqual([{ field: 'html.text', base: MAIN, pr: PR, file: PAGE, line: 35 }]);
        expect(d.reason).toContain('changed as the PR intended');
    });

    it('a markup-only change (the list loses its classes) is a finding the diff cannot explain', () => {
        const classPatch = [
            '@@ -31,3 +31,3 @@',
            '             </p>',
            '-            <ul className="list-disc list-inside space-y-2 text-zinc-600">',
            '+            <ul className="list-none">',
            `               <li>Multi-stage Docker build for optimal image size</li>`,
        ].join('\n');
        const steps = [
            answered('base', 1, page(MAIN)),
            answered('base', 2, page(MAIN)),
            answered('pr', 1, page(MAIN, { listClass: 'list-none' })),
            answered('pr', 2, page(MAIN, { listClass: 'list-none' })),
        ];
        const decision = gate(steps);
        expect(decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change', differingFields: ['html.markup.sha256'] });

        const d = decideIntendedChange(decision, steps, { diff: [{ path: PAGE, patch: classPatch }], reachableFiles: [PAGE] });

        expect(d).toBe(decision);
        expect(d.intendedChange).toBeUndefined();
    });

    it('a reworded line together with markup the diff also changes stays a finding: the skeleton is never explained', () => {
        const steps = [
            answered('base', 1, page(MAIN)),
            answered('base', 2, page(MAIN)),
            answered('pr', 1, page(PR, { listClass: 'list-none' })),
            answered('pr', 2, page(PR, { listClass: 'list-none' })),
        ];
        const decision = gate(steps);
        expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['html.text', 'html.markup.sha256'] });
        expect(decideIntendedChange(decision, steps, { diff: pageDiff, reachableFiles: [PAGE] }).intendedChange).toBeUndefined();
    });

    it('demo-nextjs#3: the same page on another build (chunk hashes and order) and other requests is no finding', () => {
        const steps = [
            answered('base', 1, page(MAIN)),
            answered('base', 2, page(MAIN)),
            answered('pr', 1, page(MAIN, { build: '0c0ffee1', requestId: 'x' })),
            answered('pr', 2, page(MAIN, { build: '0c0ffee1', requestId: 'y' })),
        ];
        expect(gate(steps)).toMatchObject({ verdict: 'not_reproduced', differingFields: [] });
    });
});
