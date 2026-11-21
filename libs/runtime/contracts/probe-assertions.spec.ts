import {
    evaluateIntentAssertion,
    isRouteInvariant,
    IntentAssertionSchema,
    intentAssertionReads,
    intentAssertionText,
    parseIntentExpression,
    parseJsonPath,
    StatedIntentSchema,
    type IntentAnswer,
} from './probe-assertions';

const json = (value: unknown, status = 200, request?: unknown): IntentAnswer => ({ status, body: { json: true, value }, ...(request !== undefined ? { request } : {}) });
const quote = { item: 'monitor', quantity: 2, subtotal: 400, discount: 80, total: 320, charge: 400 };

describe('intent assertion paths', () => {
    it('reads the minimal $.a.b[0] subset', () => {
        expect(parseJsonPath('$')).toEqual([]);
        expect(parseJsonPath('$.orders[0].item')).toEqual(['orders', 0, 'item']);
        expect(parseJsonPath('$[1]')).toEqual([1]);
    });

    it('refuses anything outside the subset: filters, wildcards, quotes, recursion, no root', () => {
        for (const p of ['$..item', '$.*', '$[?(@.x)]', "$['a']", 'total', '$.a-b', '$.', '$[01x]', `$${'.a'.repeat(17)}`]) {
            expect(parseJsonPath(p)).toBeUndefined();
        }
    });
});

describe('intent assertion expressions', () => {
    it('parses + - * / with parentheses, numbers and paths of the response and of the request', () => {
        expect(parseIntentExpression('($.subtotal - $.discount) * 1')).toBeDefined();
        expect(parseIntentExpression('$request.quantity * 50')).toBeDefined();
        expect(parseIntentExpression('-$.a + 2.5')).toBeDefined();
    });

    it('refuses code, functions, unbalanced parentheses and over-long input', () => {
        for (const e of ['process.exit()', '$.a ** 2', 'Math.max($.a, 1)', '($.a', '$.a)', '$.a $.b', '1e3', '$.a; 1', 'x'.repeat(301), '', '(((((((((((((((((1)))))))))))))))))']) {
            expect(parseIntentExpression(e)).toBeUndefined();
        }
    });
});

describe('the closed set of intent assertions', () => {
    it('accepts status, equals, sameAs and computed, and nothing else', () => {
        expect(IntentAssertionSchema.safeParse({ kind: 'status', status: 400 }).success).toBe(true);
        expect(IntentAssertionSchema.safeParse({ kind: 'equals', path: '$.total', value: 320 }).success).toBe(true);
        expect(IntentAssertionSchema.safeParse({ kind: 'equals', path: '$', value: [{ id: 1 }] }).success).toBe(true);
        expect(IntentAssertionSchema.safeParse({ kind: 'sameAs', path: '$.charge', other: '$.total' }).success).toBe(true);
        expect(IntentAssertionSchema.safeParse({ kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' }).success).toBe(true);
        expect(IntentAssertionSchema.safeParse({ kind: 'regex', path: '$.total', pattern: '.*' }).success).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'equals', path: '$..total', value: 1 }).success).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'equals', path: '$.total' }).success).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'computed', path: '$.total', expr: 'eval("1")' }).success).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'status', status: 99 }).success).toBe(false);
    });

    it('cites a source that is the description or one linked task', () => {
        expect(StatedIntentSchema.safeParse({ quote: '`total` is `unitPrice × quantity`.', source: 'description' }).success).toBe(true);
        expect(StatedIntentSchema.safeParse({ quote: 'refused with 400', source: 'task:KR-12' }).success).toBe(true);
        expect(StatedIntentSchema.safeParse({ quote: 'refused with 400', source: 'readme' }).success).toBe(false);
        expect(StatedIntentSchema.safeParse({ quote: '', source: 'description' }).success).toBe(false);
    });
});

describe('evaluateIntentAssertion', () => {
    it('sameAs fails when charge is not total (kr-shop #7) and holds when it is (#8)', () => {
        const a = IntentAssertionSchema.parse({ kind: 'sameAs', path: '$.charge', other: '$.total' });
        expect(evaluateIntentAssertion(a, json(quote))).toEqual({ held: false, expected: '$.charge = $.total (320)', received: '400' });
        expect(evaluateIntentAssertion(a, json({ ...quote, charge: 320 })).held).toBe(true);
    });

    it('computed holds within its tolerance and fails outside it', () => {
        const a = IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' });
        expect(evaluateIntentAssertion(a, json({ id: 1, quantity: 2, unitPrice: 50, total: 100.004 })).held).toBe(true);
        expect(evaluateIntentAssertion(a, json({ id: 1, quantity: 2, unitPrice: 50, total: 52 }))).toEqual({ held: false, expected: '$.total = $.unitPrice * $.quantity = 100', received: '52' });
        const exact = IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity', tolerance: 0 });
        expect(evaluateIntentAssertion(exact, json({ quantity: 2, unitPrice: 50, total: 100.004 })).held).toBe(false);
    });

    it('computed reads the request body with $request, and respects precedence and parentheses', () => {
        const a = IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '($.subtotal - $.discount) * $request.quantity / 2' });
        expect(evaluateIntentAssertion(a, json(quote, 200, { item: 'monitor', quantity: 2 })).held).toBe(true);
        const b = IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.subtotal - $.discount * 2' });
        expect(evaluateIntentAssertion(b, json({ ...quote, total: 240 })).held).toBe(true);
    });

    it('an expression that cannot be computed (an absent or non-number operand, a division by zero) is inconclusive, never a failure (kr-shop #8)', () => {
        const a = IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' });
        expect(evaluateIntentAssertion(a, json({ quantity: 2, total: 100 }))).toMatchObject({ held: false, inconclusive: true, received: '100' });
        expect(evaluateIntentAssertion(a, json({ quantity: 'two', unitPrice: 50, total: 100 }))).toMatchObject({ held: false, inconclusive: true });
        const d = IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.total / 0' });
        expect(evaluateIntentAssertion(d, json({ total: 1 }))).toMatchObject({ held: false, inconclusive: true });
        // A field the answer should have and does not is a failure.
        const e = IntentAssertionSchema.parse({ kind: 'equals', path: '$.unitPrice', value: 50 });
        expect(evaluateIntentAssertion(e, json({ id: 1 }))).toEqual({ held: false, expected: '$.unitPrice = 50', received: 'absent' });
        expect(evaluateIntentAssertion(a, json({ quantity: 2, unitPrice: 50 }))).toMatchObject({ held: false, received: 'absent' });
        expect(evaluateIntentAssertion(a, json({ quantity: 2, unitPrice: 50 })).inconclusive).toBeUndefined();
    });

    it('$request.body.x is refused: the request root already is the body (kr-shop #8 wrote $request.body.quantity)', () => {
        expect(parseIntentExpression('50 * $request.body.quantity')).toBeUndefined();
        expect(IntentAssertionSchema.safeParse({ kind: 'computed', path: '$.subtotal', expr: '50 * $request.body.quantity' }).success).toBe(false);
        expect(parseIntentExpression('50 * $request.quantity')).toBeDefined();
    });

    it('equals compares a whole JSON value, key order aside (kr-shop #10 against #9)', () => {
        const a = IntentAssertionSchema.parse({ kind: 'equals', path: '$', value: [{ id: 1, item: 'keyboard', quantity: 2 }] });
        expect(evaluateIntentAssertion(a, json([{ quantity: 2, item: 'keyboard', id: 1 }])).held).toBe(true);
        expect(evaluateIntentAssertion(a, json([{ id: 1, item: 'keyboard', quantity: 2 }, { id: 2, item: 'monitor', quantity: 1 }])).held).toBe(false);
    });

    it('status compares the HTTP status; a body that is not JSON resolves no path', () => {
        expect(evaluateIntentAssertion(IntentAssertionSchema.parse({ kind: 'status', status: 400 }), json({}, 400)).held).toBe(true);
        expect(evaluateIntentAssertion(IntentAssertionSchema.parse({ kind: 'status', status: 201 }), json({}, 400))).toEqual({ held: false, expected: 'status 201', received: 'status 400' });
        const e = IntentAssertionSchema.parse({ kind: 'equals', path: '$', value: 'ok' });
        expect(evaluateIntentAssertion(e, { status: 200, body: { json: false } }).held).toBe(false);
    });

    it('names what each assertion reads: its response paths and whether it reads the status', () => {
        expect(intentAssertionReads(IntentAssertionSchema.parse({ kind: 'status', status: 400 }))).toEqual({ status: true, paths: [] });
        expect(intentAssertionReads(IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.unitPrice * $request.quantity' }))).toEqual({
            status: false,
            paths: [['total'], ['unitPrice']],
        });
        expect(intentAssertionText(IntentAssertionSchema.parse({ kind: 'sameAs', path: '$.charge', other: '$.total' }))).toBe('$.charge == $.total');
    });
});

describe('length paths (kr-shop #9: "returns only keyboard orders")', () => {
    const both = [{ id: 1, item: 'keyboard', quantity: 2 }, { id: 2, item: 'monitor', quantity: 1 }];

    it('$.length is the length of the root array, and fails on the bug that still lists both orders', () => {
        const a = IntentAssertionSchema.parse({ kind: 'equals', path: '$.length', value: 1 });
        expect(evaluateIntentAssertion(a, json([both[0]])).held).toBe(true);
        expect(evaluateIntentAssertion(a, json(both))).toEqual({ held: false, expected: '$.length = 1', received: '2' });
    });

    it('$.items.length counts a nested array, and a real "length" key of an object is read as the key', () => {
        const a = IntentAssertionSchema.parse({ kind: 'equals', path: '$.items.length', value: 2 });
        expect(evaluateIntentAssertion(a, json({ items: both })).held).toBe(true);
        const key = IntentAssertionSchema.parse({ kind: 'equals', path: '$.length', value: 'long' });
        expect(evaluateIntentAssertion(key, json({ length: 'long' })).held).toBe(true);
        const computed = IntentAssertionSchema.parse({ kind: 'computed', path: '$.count', expr: '$.items.length' });
        expect(evaluateIntentAssertion(computed, json({ count: 2, items: both })).held).toBe(true);
    });
});

describe('isRouteInvariant', () => {
    it('a rule over response fields holds for every request of the route: sameAs, and computed without $request', () => {
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'sameAs', path: '$.charge', other: '$.total' }))).toBe(true);
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$.unitPrice * $.quantity' }))).toBe(true);
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'computed', path: '$.discount', expr: '$.subtotal * 0.20' }))).toBe(true);
    });

    it('a status, a literal or a rule that reads the request stays tied to its own request', () => {
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'status', status: 400 }))).toBe(false);
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'equals', path: '$.total', value: 100 }))).toBe(false);
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '$request.quantity * 50' }))).toBe(false);
        expect(isRouteInvariant(IntentAssertionSchema.parse({ kind: 'computed', path: '$.total', expr: '100' }))).toBe(false);
    });
});

describe('every (kr-shop #10: "returns only keyboard orders")', () => {
    const keyboard = { id: 1, item: 'keyboard', quantity: 2 };
    const monitor = { id: 2, item: 'monitor', quantity: 1 };
    const every = (over: Record<string, unknown> = {}) => IntentAssertionSchema.parse({ kind: 'every', path: '$[*].item', value: 'keyboard', ...over });

    it('holds when every element has the field equal to the literal, and fails on the bug that still lists a monitor', () => {
        expect(evaluateIntentAssertion(every(), json([keyboard])).held).toBe(true);
        expect(evaluateIntentAssertion(every(), json([keyboard, monitor]))).toEqual({ held: false, expected: '$[*].item = "keyboard"', received: '$[1].item = "monitor"' });
    });

    it('reads a nested array, and an element without the field fails', () => {
        const nested = IntentAssertionSchema.parse({ kind: 'every', path: '$.items[*].sku', value: 'kb-1' });
        expect(evaluateIntentAssertion(nested, json({ items: [{ sku: 'kb-1' }, { sku: 'kb-1' }] })).held).toBe(true);
        expect(evaluateIntentAssertion(nested, json({ items: [{ sku: 'kb-1' }, { id: 3 }] })).held).toBe(false);
        expect(evaluateIntentAssertion(nested, json({ items: 'none' })).held).toBe(false);
    });

    it('an empty array holds only when the assertion says so', () => {
        expect(evaluateIntentAssertion(every(), json([]))).toMatchObject({ held: false, received: 'an empty array' });
        expect(evaluateIntentAssertion(every({ allowEmpty: true }), json([])).held).toBe(true);
    });

    it('takes exactly one [*], only in an every path', () => {
        expect(IntentAssertionSchema.safeParse({ kind: 'every', path: '$.items', value: 1 }).success).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'every', path: '$[*][*].a', value: 1 }).success).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'equals', path: '$[*].item', value: 1 }).success).toBe(false);
        expect(intentAssertionText(every())).toBe('$[*].item == "keyboard"');
    });
});

describe('includes (kr-shop #13: a quoted error message)', () => {
    const message = 'at most 10 units per order';

    it("a path's string value contains the literal", () => {
        const a = IntentAssertionSchema.parse({ kind: 'includes', path: '$.error', value: message });
        expect(evaluateIntentAssertion(a, json({ error: message }, 400)).held).toBe(true);
        expect(evaluateIntentAssertion(a, json({ error: 'quantity too large' }, 400))).toEqual({ held: false, expected: '$.error includes "at most 10 units per order"', received: '"quantity too large"' });
    });

    it('on $ it searches the whole answer: every string of a JSON body, or a body that is not JSON', () => {
        const a = IntentAssertionSchema.parse({ kind: 'includes', path: '$', value: message });
        expect(evaluateIntentAssertion(a, json({ error: message }, 400)).held).toBe(true);
        expect(evaluateIntentAssertion(a, { status: 400, body: { json: false, text: `Error: ${message}` } }).held).toBe(true);
        expect(evaluateIntentAssertion(a, json({ error: 'nope' }, 400)).held).toBe(false);
        expect(IntentAssertionSchema.safeParse({ kind: 'includes', path: '$', value: '' }).success).toBe(false);
    });
});
