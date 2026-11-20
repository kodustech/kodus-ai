import { IntentAssertionSchema, type IntentAssertion } from '@libs/runtime/contracts/probe-assertions';
import type { Probe, ProbeResult } from '@libs/runtime/probe/probe.schema';

import { decideNewEndpoint, decideProbe, type GateDecision, type GateStep } from './gate';
import { expectedHolds, normalizeFields } from './probe-fields';
import { decideStatedIntent, type StatedIntentCheck, statedIntentChecksFor } from './stated-intent';

// The kr-shop pairs of docs/runtime/intent-oracle.md, 2026-11-18: each feature
// as a PR with a planted bug and as a correct PR with the same description.
// The statuses and the JSON answers are the ones the Runs recorded (the
// quote route's 404 body on the base stands in: only its status was kept);
// the steps go through the gate's own normalization, so these are the fields
// the replay produces.

const IMAGE = 'img-kr-shop';
const READY = 200;

function probe(id: string, method: 'GET' | 'POST', path: string, body?: unknown): Probe {
    return {
        id,
        origin: 'agent',
        purpose: 'what the PR describes',
        expected: 'what the PR describes',
        compare: ['status', 'json'],
        spec: {
            kind: 'http',
            target: { service: 'app', port: 3000 },
            method,
            path,
            ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
            timeoutMs: 10_000,
        },
    };
}

let n = 0;
/** One observer round as the replay records it (worker/run/probe-fields.ts toGateStep). */
function round(p: Probe, side: 'base' | 'pr', r: number, status: number, body: unknown, intent?: StatedIntentCheck[]): GateStep {
    const result = { executor: 'observer', imageId: IMAGE, transport: 'ok', http: { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } } as unknown as ProbeResult;
    return {
        stepId: `s${++n}`,
        probeId: p.id,
        side,
        round: r,
        executor: 'observer',
        imageId: IMAGE,
        transport: 'ok',
        vmHealth: 'ok',
        timedOut: false,
        fields: normalizeFields(p, result),
        expectedHolds: expectedHolds(p, result, undefined, intent),
        readyStatus: READY,
    };
}

type Answer = { status: number; body: unknown };

/** Base and PR rounds until the gate decides, as the replay plays them; then the routes the diff adds. */
function replay(p: Probe, base: Answer, pr: Answer, opts: { added?: boolean; intent?: StatedIntentCheck[]; prRounds?: Answer[] } = {}) {
    const steps: GateStep[] = [];
    let b = 0;
    let r = 0;
    const playBase = () => steps.push(round(p, 'base', ++b, base.status, base.body, opts.intent));
    const playPr = () => {
        const a = opts.prRounds?.[r] ?? pr;
        steps.push(round(p, 'pr', ++r, a.status, a.body, opts.intent));
    };
    playBase();
    playBase();
    playPr();
    let d: GateDecision = decideProbe(steps, { pinnedImageId: IMAGE });
    while (d.kind === 'more_rounds') {
        for (let i = 0; i < d.base; i++) playBase();
        for (let i = 0; i < d.pr; i++) playPr();
        d = decideProbe(steps, { pinnedImageId: IMAGE });
    }
    return { decision: decideNewEndpoint(d, steps, { addedByDiff: !!opts.added }), steps };
}

const assertion = (a: unknown): IntentAssertion => IntentAssertionSchema.parse(a);
const check = (probeId: string, quote: string, ...assertions: unknown[]): StatedIntentCheck => ({ probeId, intent: { quote, source: 'description' }, assertions: assertions.map(assertion) });

describe('decideStatedIntent on kr-shop (docs/runtime/intent-oracle.md)', () => {
    describe('#7/#8 quote with a coupon: POST /orders/quote, a route the PR adds', () => {
        const p = probe('intent-1', 'POST', '/orders/quote', { item: 'monitor', quantity: 2, coupon: 'SAVE20' });
        const said = check('intent-1', '`charge` is what the card is charged, so it must equal `total`.', { kind: 'sameAs', path: '$.charge', other: '$.total' });
        const base = { status: 404, body: { error: 'not found' } };

        it('the bug (#7) charges the subtotal: an intent mismatch, never a finding', () => {
            const pr = { status: 200, body: { item: 'monitor', quantity: 2, subtotal: 400, discount: 80, total: 320, charge: 400 } };
            const { decision, steps } = replay(p, base, pr, { added: true, intent: [said] });
            expect(decision).toMatchObject({ verdict: 'new_endpoint' });
            const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE, requestBody: p.spec.kind === 'http' ? p.spec.body : undefined });
            expect(out.decision.verdict).toBe('intent_mismatch');
            expect(out.decision.findingKind).toBeUndefined();
            expect(out.statedIntents).toEqual([
                expect.objectContaining({ probeId: 'intent-1', quote: said.intent.quote, assertions: 1, held: 0, failures: [{ assertion: '$.charge == $.total', expected: '$.charge = $.total (320)', received: '400' }] }),
            ]);
        });

        it('the correct PR (#8) charges the total: the new endpoint stands, its assertion held', () => {
            const pr = { status: 200, body: { item: 'monitor', quantity: 2, subtotal: 400, discount: 80, total: 320, charge: 320 } };
            const { decision, steps } = replay(p, base, pr, { added: true, intent: [said] });
            const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
            expect(out.decision.verdict).toBe('new_endpoint');
            expect(out.statedIntents[0]).toMatchObject({ assertions: 1, held: 1, failures: [] });
        });
    });

    describe('#9/#10 filter by item: GET /orders?item=keyboard', () => {
        const p = probe('intent-1', 'GET', '/orders?item=keyboard');
        const said = check('intent-1', '`GET /orders?item=keyboard` returns only keyboard orders (seed: order 1).', { kind: 'equals', path: '$', value: [{ id: 1, item: 'keyboard', quantity: 2 }] });
        const base = { status: 200, body: [{ id: 1, item: 'keyboard', quantity: 2 }, { id: 2, item: 'monitor', quantity: 1 }] };

        it('the correct PR (#10) narrows the list: a described change, not a regression', () => {
            const { decision, steps } = replay(p, base, { status: 200, body: [{ id: 1, item: 'keyboard', quantity: 2 }] }, { intent: [said] });
            expect(decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change', differingFields: ['json'] });
            const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
            expect(out.decision).toMatchObject({ verdict: 'described_change', differingFields: ['json'] });
            expect(out.decision.findingKind).toBeUndefined();
        });

        it('the bug (#9) reads ?items, so ?item=keyboard still returns both orders: an intent mismatch', () => {
            const { decision, steps } = replay(p, base, base, { intent: [said] });
            expect(decision.verdict).toBe('pre_existing');
            const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
            expect(out.decision.verdict).toBe('intent_mismatch');
            expect(out.statedIntents[0].failures[0]).toMatchObject({ received: '[{"id":1,"item":"keyboard","quantity":2},{"id":2,"item":"monitor","quantity":1}]' });
        });
    });

    describe('#11/#12 order total: GET /orders/1', () => {
        const p = probe('intent-1', 'GET', '/orders/1');
        const said = check('intent-1', '`total` is `unitPrice × quantity`.', { kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' });
        const base = { status: 200, body: { id: 1, item: 'keyboard', quantity: 2 } };

        it('the correct PR (#12) adds unitPrice and total: a described change, not a regression', () => {
            const { decision, steps } = replay(p, base, { status: 200, body: { id: 1, item: 'keyboard', quantity: 2, unitPrice: 50, total: 100 } }, { intent: [said] });
            expect(decision).toMatchObject({ verdict: 'finding', differingFields: ['json.total', 'json.unitPrice'] });
            expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
        });

        it('the bug (#11) answers total 52: an intent mismatch', () => {
            const { decision, steps } = replay(p, base, { status: 200, body: { id: 1, item: 'keyboard', quantity: 2, unitPrice: 50, total: 52 } }, { intent: [said] });
            const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
            expect(out.decision.verdict).toBe('intent_mismatch');
            expect(out.statedIntents[0].failures[0]).toEqual({ assertion: '$.total == $.unitPrice * $.quantity', expected: '$.total = $.unitPrice * $.quantity = 100', received: '52' });
        });

        it("the planner's own probe of the same request keeps its regression on the bug: only a held assertion explains", () => {
            const planned = probe('order-1', 'GET', '/orders/1');
            const { decision, steps } = replay(planned, base, { status: 200, body: { id: 1, item: 'keyboard', quantity: 2, unitPrice: 50, total: 52 } });
            const out = decideStatedIntent(decision, steps, [said], { mismatch: false, pinnedImageId: IMAGE });
            expect(out.decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change' });
            expect(out.statedIntents[0].held).toBe(0);
        });
    });

    describe('#13/#14 at most 10 units: POST /orders', () => {
        const created = (quantity: number) => ({ status: 201, body: { id: 3, item: 'keyboard', quantity } });
        const refused = { status: 400, body: { error: 'at most 10 units per order' } };

        it('the correct PR (#14) refuses 11 with 400: a described change (the body of the new status goes with it)', () => {
            const p = probe('intent-1', 'POST', '/orders', { item: 'keyboard', quantity: 11 });
            const said = check('intent-1', '`quantity` 11 or more is refused with 400', { kind: 'status', status: 400 });
            const { decision, steps } = replay(p, created(11), refused, { intent: [said] });
            expect(decision).toMatchObject({ verdict: 'finding', differingFields: expect.arrayContaining(['status', 'json.error']) });
            expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
        });

        it('the bug (#13) also refuses 10: an intent mismatch on the sentence that 10 is still accepted', () => {
            const p = probe('intent-2', 'POST', '/orders', { item: 'keyboard', quantity: 10 });
            const said = check('intent-2', '`POST /orders` with `quantity` 10 is still accepted (201).', { kind: 'status', status: 201 });
            const { decision, steps } = replay(p, created(10), refused, { intent: [said] });
            const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
            expect(out.decision.verdict).toBe('intent_mismatch');
            expect(out.statedIntents[0].failures[0]).toMatchObject({ expected: 'status 201', received: 'status 400' });
        });
    });
});

describe('decideStatedIntent: what a passed assertion never explains', () => {
    const p = probe('intent-1', 'GET', '/orders/1');
    const base = { status: 200, body: { id: 1, item: 'keyboard', quantity: 2 } };

    it('a difference in a field no assertion reads stays a regression', () => {
        const said = check('intent-1', 'total is unitPrice × quantity', { kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' });
        const { decision, steps } = replay(p, base, { status: 200, body: { id: 1, item: 'mouse', quantity: 2, unitPrice: 50, total: 100 } });
        const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
        expect(out.decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change' });
        expect(out.statedIntents[0]).toMatchObject({ held: 1 });
    });

    it('a 5xx is never explained, and never turned into a mismatch', () => {
        const said = check('intent-1', 'refused with 500', { kind: 'status', status: 500 });
        const { decision, steps } = replay(p, base, { status: 500, body: { error: 'boom' } });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision).toMatchObject({ verdict: 'finding' });
        const wrong = check('intent-1', 'still answered', { kind: 'status', status: 200 });
        expect(decideStatedIntent(decision, steps, [wrong], { mismatch: true, pinnedImageId: IMAGE }).decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change' });
    });

    it('an assertion that fails on one PR round is a mismatch even when the others held', () => {
        const said = check('intent-1', 'total is 100', { kind: 'equals', path: '$.total', value: 100 });
        const good = { status: 200, body: { id: 1, item: 'keyboard', quantity: 2, total: 100 } };
        const { decision, steps } = replay(p, base, good, { prRounds: [good, { status: 200, body: { id: 1, item: 'keyboard', quantity: 2, total: 99 } }] });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('intent_mismatch');
    });

    it('a status assertion alone explains no body change while the status stays the same', () => {
        const said = check('intent-1', 'answers 200', { kind: 'status', status: 200 });
        const { decision, steps } = replay(p, base, { status: 200, body: { id: 1, item: 'mouse', quantity: 2 } });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('finding');
    });

    it('an assertion through an array index explains no change to the whole array', () => {
        const list = probe('intent-1', 'GET', '/orders?item=keyboard');
        const said = check('intent-1', 'the first order is a keyboard', { kind: 'equals', path: '$[0].item', value: 'keyboard' });
        const { decision, steps } = replay(list, { status: 200, body: [{ id: 1, item: 'keyboard' }, { id: 2, item: 'monitor' }] }, { status: 200, body: [{ id: 1, item: 'keyboard' }] });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('finding');
    });

    it('an inconclusive comparison still shows a PR answer that breaks its sentence', () => {
        const said = check('intent-1', 'total is 100', { kind: 'equals', path: '$.total', value: 100 });
        const inconclusive = { kind: 'verdict' as const, verdict: 'inconclusive' as const, reason: 'base varies', differingFields: [], maskedFields: [] };
        const steps = [round(p, 'base', 1, 200, base.body), round(p, 'base', 2, 200, base.body), round(p, 'pr', 1, 200, { total: 1 })];
        expect(decideStatedIntent(inconclusive, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('intent_mismatch');
    });

    it('a blocked probe, a PR round that did not answer or one on another image decides nothing', () => {
        const said = check('intent-1', 'total is 100', { kind: 'equals', path: '$.total', value: 100 });
        const steps = [round(p, 'base', 1, 200, base.body), round(p, 'base', 2, 200, base.body), round(p, 'pr', 1, 200, { total: 1 })];
        const blocker = { kind: 'verdict' as const, verdict: 'blocker' as const, reason: 'missing env', differingFields: [], maskedFields: [] };
        expect(decideStatedIntent(blocker, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('blocker');
        const finding = { kind: 'verdict' as const, verdict: 'finding' as const, findingKind: 'behavior_change' as const, reason: 'x', differingFields: ['json.total'], maskedFields: [] };
        const lost = steps.map((s) => (s.side === 'pr' ? { ...s, transport: 'lost' as const, fields: {} } : s));
        expect(decideStatedIntent(finding, lost, [said], { mismatch: true, pinnedImageId: IMAGE })).toMatchObject({ decision: { verdict: 'finding' }, statedIntents: [] });
        const elsewhere = steps.map((s) => (s.side === 'pr' ? { ...s, imageId: 'img-other' } : s));
        expect(decideStatedIntent(finding, elsewhere, [said], { mismatch: true, pinnedImageId: IMAGE })).toMatchObject({ decision: { verdict: 'finding' }, statedIntents: [] });
    });
});

describe('a length assertion (kr-shop #9: the author asserted $[0].item, which the bug also satisfies)', () => {
    const p = probe('intent-1', 'GET', '/orders?item=keyboard');
    const said = check('intent-1', '`GET /orders?item=keyboard` returns only keyboard orders (seed: order 1).', { kind: 'equals', path: '$.length', value: 1 });
    const both = { status: 200, body: [{ id: 1, item: 'keyboard', quantity: 2 }, { id: 2, item: 'monitor', quantity: 1 }] };

    it('catches the bug that still lists both orders', () => {
        const { decision, steps } = replay(p, both, both, { intent: [said] });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('intent_mismatch');
    });

    it('counts the list but never explains what is in it: the whole value does', () => {
        const { decision, steps } = replay(p, both, { status: 200, body: [{ id: 1, item: 'keyboard', quantity: 2 }] }, { intent: [said] });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('finding');
    });
});

describe('statedIntentChecksFor: which intent checks a planned probe gets', () => {
    const intent = (id: string, path: string, ...assertions: unknown[]) => ({
        probe: probe(id, 'GET', path),
        intent: { quote: '`total` is `unitPrice × quantity`.', source: 'description' as const },
        intentAssertions: assertions.map(assertion),
    });
    const rule = { kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' };
    const literal = { kind: 'equals', path: '$.total', value: 100 };
    const intents = [intent('intent-1', '/orders/1', rule, literal)];

    it('the same request: every assertion of its intent probe, a failure recorded beside the planned verdict', () => {
        expect(statedIntentChecksFor({ probe: probe('order-1', 'GET', '/orders/1'), entryPoint: 'GET /orders/:id' }, intents)).toEqual({
            checks: [{ probeId: 'intent-1', intent: intents[0].intent, assertions: [assertion(rule), assertion(literal)] }],
            explainOnly: false,
        });
    });

    it('another request of the same method and route: only the rules over response fields, to explain and never to flag', () => {
        expect(statedIntentChecksFor({ probe: probe('order-2', 'GET', '/orders/2'), entryPoint: 'GET /orders/:id' }, intents)).toEqual({
            checks: [{ probeId: 'intent-1', intent: intents[0].intent, assertions: [assertion(rule)] }],
            explainOnly: true,
        });
    });

    it('another route, or a probe outside the diff, gets none', () => {
        expect(statedIntentChecksFor({ probe: probe('list', 'GET', '/orders'), entryPoint: 'GET /orders' }, intents).checks).toEqual([]);
        expect(statedIntentChecksFor({ probe: probe('order-2', 'GET', '/orders/2'), entryPoint: 'unmapped' }, intents).checks).toEqual([]);
        expect(statedIntentChecksFor({ probe: probe('order-2', 'DELETE' as 'GET', '/orders/2'), entryPoint: 'DELETE /orders/:id' }, intents).checks).toEqual([]);
    });

    it("explains order 2's planned difference with the rule written for order 1 (kr-shop #12)", () => {
        const planned = probe('order-2', 'GET', '/orders/2');
        const { checks } = statedIntentChecksFor({ probe: planned, entryPoint: 'GET /orders/:id' }, intents);
        const { decision, steps } = replay(planned, { status: 200, body: { id: 2, item: 'monitor', quantity: 1 } }, { status: 200, body: { id: 2, item: 'monitor', quantity: 1, unitPrice: 200, total: 200 } });
        expect(decideStatedIntent(decision, steps, checks, { mismatch: false, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
    });
});

describe('every and includes (kr-shop #10 and #13 on release v1d)', () => {
    const p = probe('p-orders-filter', 'GET', '/orders?item=keyboard');
    const QUOTE = '`GET /orders?item=keyboard` returns only keyboard orders (seed: order 1).';
    const keyboard = { id: 1, item: 'keyboard', quantity: 2 };
    const base = { status: 200, body: [keyboard, { id: 2, item: 'monitor', quantity: 1 }] };
    const correct = { status: 200, body: [keyboard] };
    const every = { kind: 'every', path: '$[*].item', value: 'keyboard' };
    const length = { kind: 'equals', path: '$.length', value: 1 };

    it("#10's planned probe: every and length both held, so the narrowed list is a described change", () => {
        const said = check('intent-1', QUOTE, { kind: 'status', status: 200 }, length, every);
        const { decision, steps } = replay(p, base, correct);
        expect(decideStatedIntent(decision, steps, [said], { mismatch: false, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
    });

    it('every alone explains the list when the sentence says only, and not otherwise', () => {
        const { decision, steps } = replay(p, base, correct);
        expect(decideStatedIntent(decision, steps, [check('intent-1', QUOTE, every)], { mismatch: false, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
        expect(decideStatedIntent(decision, steps, [check('intent-1', 'GET /orders?item=keyboard lists keyboard orders.', every)], { mismatch: false, pinnedImageId: IMAGE }).decision.verdict).toBe('finding');
    });

    it('#9: the bug still lists the monitor, so every fails: an intent mismatch', () => {
        const said = check('intent-1', QUOTE, length, every);
        const { decision, steps } = replay(probe('intent-1', 'GET', '/orders?item=keyboard'), base, base, { intent: [said] });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('intent_mismatch');
    });

    it('#13/#14: the quoted message held with includes, so the correct PR is not flagged; includes alone explains no body', () => {
        const post = probe('intent-2', 'POST', '/orders', { item: 'keyboard', quantity: 11 });
        const said = check('intent-2', '`quantity` 11 or more is refused with 400 `at most 10 units per order`.', { kind: 'includes', path: '$', value: 'at most 10 units per order' });
        const refused = { status: 400, body: { error: 'at most 10 units per order' } };
        const { decision, steps } = replay(post, { status: 201, body: { id: 3, item: 'keyboard', quantity: 11 } }, refused, { intent: [said] });
        expect(decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('finding');
        const withStatus = check('intent-2', said.intent.quote, { kind: 'status', status: 400 }, { kind: 'includes', path: '$', value: 'at most 10 units per order' });
        expect(decideStatedIntent(decision, steps, [withStatus], { mismatch: true, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
    });
});

describe('what cannot be evaluated is never a mismatch (kr-shop #8 on release v1e)', () => {
    const quote = '`total` is the subtotal minus the discount, and `charge` is what the card is charged, so it must equal `total`.';
    const refusedBody = { error: 'quantity must be a whole number' };

    it('a field assertion on an answer the app refused (4xx) is inconclusive when the probe asserts no status', () => {
        const p = probe('intent-2', 'POST', '/orders/quote', { item: 'mouse', quantity: 1.5 });
        const said = check('intent-2', quote, { kind: 'computed', path: '$.subtotal', expr: '25 * $request.quantity' });
        const { decision, steps } = replay(p, { status: 404, body: { error: 'not found' } }, { status: 400, body: refusedBody }, { added: true, intent: [said] });
        expect(decision.verdict).toBe('new_endpoint');
        const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE, requestBody: p.spec.kind === 'http' ? p.spec.body : undefined });
        expect(out.decision.verdict).toBe('new_endpoint');
        expect(out.statedIntents[0]).toMatchObject({ assertions: 1, held: 0, inconclusive: 1, failures: [] });
    });

    it('with a 2xx status asserted, the status is what fails', () => {
        const p = probe('intent-2', 'POST', '/orders/quote', { item: 'mouse', quantity: 1.5 });
        const said = check('intent-2', quote, { kind: 'status', status: 200 }, { kind: 'computed', path: '$.subtotal', expr: '25 * $request.quantity' });
        const { decision, steps } = replay(p, { status: 404, body: { error: 'not found' } }, { status: 400, body: refusedBody }, { added: true, intent: [said] });
        const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
        expect(out.decision.verdict).toBe('intent_mismatch');
        expect(out.statedIntents[0].failures).toEqual([{ assertion: 'status == 200', expected: 'status 200', received: 'status 400' }]);
    });

    it('an expression with an absent operand on a 2xx neither flags nor explains', () => {
        const p = probe('intent-1', 'POST', '/orders/quote', { item: 'monitor', quantity: 2, coupon: 'SAVE20' });
        const said = check('intent-1', quote, { kind: 'computed', path: '$.subtotal', expr: '$.unitPrice * $request.quantity' });
        const pr = { status: 200, body: { item: 'monitor', quantity: 2, subtotal: 400, discount: 80, total: 320, charge: 320 } };
        const { decision, steps } = replay(p, { status: 404, body: { error: 'not found' } }, pr, { added: true, intent: [said] });
        const out = decideStatedIntent(decision, steps, [said], { mismatch: true, pinnedImageId: IMAGE });
        expect(out.decision.verdict).toBe('new_endpoint');
        expect(out.statedIntents[0]).toMatchObject({ held: 0, inconclusive: 1, failures: [] });
    });
});

describe('a held status explains a planned probe of the same request shape (kr-shop #18 on release v1e)', () => {
    const quote = '`POST /orders` without `quantity` creates the order with quantity 1.';
    const intents = [
        {
            probe: probe('intent-1', 'POST', '/orders', { item: 'mouse' }),
            intent: { quote, source: 'description' as const },
            intentAssertions: [assertion({ kind: 'status', status: 201 }), assertion({ kind: 'equals', path: '$.quantity', value: 1 }), assertion({ kind: 'equals', path: '$.item', value: 'mouse' })],
        },
    ];

    it("the planner's post-order-omitted-quantity, same keys and other values, gets the status only, to explain", () => {
        const planned = probe('post-order-omitted-quantity', 'POST', '/orders', { item: 'widget' });
        const { checks, explainOnly } = statedIntentChecksFor({ probe: planned, entryPoint: 'POST /orders' }, intents);
        expect(explainOnly).toBe(true);
        expect(checks.map((c) => c.assertions)).toEqual([[assertion({ kind: 'status', status: 201 })]]);
        const { decision, steps } = replay(planned, { status: 400, body: { error: 'quantity is required' } }, { status: 201, body: { id: 3, item: 'widget', quantity: 1 } });
        expect(decision.verdict).toBe('finding');
        expect(decideStatedIntent(decision, steps, checks, { mismatch: false, pinnedImageId: IMAGE }).decision.verdict).toBe('described_change');
    });

    it('another key set, another query or another route gets nothing', () => {
        for (const planned of [
            { probe: probe('p', 'POST', '/orders', { item: 'widget', quantity: 2 }), entryPoint: 'POST /orders' },
            { probe: probe('p', 'POST', '/orders?dry=1', { item: 'widget' }), entryPoint: 'POST /orders' },
            { probe: probe('p', 'POST', '/orders/quote', { item: 'widget' }), entryPoint: 'POST /orders/quote' },
        ]) {
            expect(statedIntentChecksFor(planned, intents).checks).toEqual([]);
        }
    });
});
