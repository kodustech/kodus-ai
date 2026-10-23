// The control pair of each stage eval over the snapshot (evals/README.md: one
// case the stage must act on, one it must leave alone). They run on a
// repository written for them, through the same production step as the
// snapshot's cases, with no known bug from the dataset: each finding says what
// the stage owes it.
//
// The PR: `total()` gains a discount. Two real bugs: the loop reads one item
// past the end (`<=`), and a discount given in percent (10) makes the total
// negative. `count()` is unchanged.
const BASE_CART = `export interface Item {
    price: number;
    qty: number;
}

export function total(items: Item[]): number {
    let sum = 0;
    for (let i = 0; i < items.length; i++) {
        sum += items[i].price * items[i].qty;
    }
    return sum;
}

export function count(items: Item[]): number {
    let n = 0;
    for (const item of items) {
        n += item.qty;
    }
    return n;
}
`;
const HEAD_CART = `export interface Item {
    price: number;
    qty: number;
}

export function total(items: Item[], discountPercent = 0): number {
    let sum = 0;
    for (let i = 0; i <= items.length; i++) {
        sum += items[i].price * items[i].qty;
    }
    return sum - sum * discountPercent;
}

export function count(items: Item[]): number {
    let n = 0;
    for (const item of items) {
        n += item.qty;
    }
    return n;
}
`;

const PR = {
    caseId: 'funnel-control-cart',
    prTitle: 'Apply a discount to the cart total',
    prBody: 'total() takes the discount the checkout page shows, in percent.',
    repositoryFullName: 'eval/funnel-controls',
    reviewMode: 'normal',
    repoBase: { 'src/cart.ts': BASE_CART },
    repoFiles: { 'src/cart.ts': HEAD_CART },
};

const finding = (lines, severity, summary, content, existingCode) => ({
    relevantFile: 'src/cart.ts',
    relevantLinesStart: lines[0],
    relevantLinesEnd: lines[1],
    language: 'typescript',
    label: 'bug',
    severity,
    oneSentenceSummary: summary,
    suggestionContent: content,
    existingCode,
    improvedCode: '',
});

const OFF_BY_ONE = finding(
    [8, 9],
    'high',
    'The loop reads one item past the end of the cart and throws',
    'WHAT: The loop condition changed from `i < items.length` to `i <= items.length`. WHY: On the last iteration `items[i]` is undefined, so `items[i].price` throws a TypeError for every non-empty cart. HOW: Keep `i < items.length`.',
    '    for (let i = 0; i <= items.length; i++) {\n        sum += items[i].price * items[i].qty;',
);
const OFF_BY_ONE_AGAIN = finding(
    [8, 9],
    'high',
    'total() crashes on every cart: the loop runs to index items.length',
    'WHAT: `for (let i = 0; i <= items.length; i++)` visits index `items.length`, which does not exist. WHY: `items[items.length].price` is a TypeError, so checkout fails whenever the cart has items. HOW: Loop while `i < items.length`, or use `for...of`.',
    '    for (let i = 0; i <= items.length; i++) {',
);
const PERCENT_AS_FRACTION = finding(
    [11, 11],
    'high',
    'A discount given in percent makes the total negative',
    'WHAT: `sum - sum * discountPercent` treats the discount as a fraction, but the parameter (and the PR) give it in percent. WHY: A 10% discount gives `sum - 10 * sum`, a negative total charged to the customer. HOW: Divide by 100: `sum - (sum * discountPercent) / 100`.',
    '    return sum - sum * discountPercent;',
);
const UNCHANGED_COUNT = finding(
    [16, 18],
    'medium',
    'count() could use reduce',
    'WHAT: `count()` sums quantities with a loop. WHY: `reduce` states the intent in one line. HOW: `return items.reduce((n, item) => n + item.qty, 0);`',
    '    for (const item of items) {\n        n += item.qty;\n    }',
);
const STYLE_NIT = finding(
    [6, 6],
    'medium',
    'Name the parameter discount instead of discountPercent',
    'WHAT: The parameter is named `discountPercent`. WHY: A shorter name reads better. HOW: Rename it to `discount`.',
    'export function total(items: Item[], discountPercent = 0): number {',
);
const FALSE_CLAIM = finding(
    [9, 9],
    'high',
    'total() ignores the quantity of each item',
    'WHAT: The sum adds `items[i].price` without multiplying by the quantity. WHY: A cart with two of an item is charged for one. HOW: Multiply the price by `items[i].qty`.',
    '        sum += items[i].price * items[i].qty;',
);

// Per stage: the control pair. `findings` is what reaches the stage; `owed`
// says, for each, whether it must come out ('kept') or not ('removed'); a
// dedup pair owes a number of survivors instead.
const CONTROLS = {
    anchoring: [
        {
            id: 'control-on-a-changed-line',
            checks: 'Keeps a finding on a line the PR changed (control: must keep)',
            findings: [OFF_BY_ONE],
            owed: ['kept'],
        },
        {
            id: 'control-outside-the-diff',
            checks: 'Drops a finding on code the PR did not touch (control: must drop)',
            findings: [UNCHANGED_COUNT],
            owed: ['removed'],
        },
    ],
    dedup: [
        {
            id: 'control-one-bug-said-twice',
            checks: 'Merges two findings of the same bug into one (control: must merge)',
            findings: [OFF_BY_ONE, OFF_BY_ONE_AGAIN],
            survivors: 1,
        },
        {
            id: 'control-two-bugs',
            checks: 'Keeps two findings of different bugs on the same PR (control: must keep both)',
            findings: [OFF_BY_ONE, PERCENT_AS_FRACTION],
            survivors: 2,
        },
    ],
    severity: [
        {
            id: 'control-a-crash',
            checks: 'Keeps a crash on every checkout above the default threshold (control: must keep)',
            findings: [OFF_BY_ONE],
            owed: ['kept'],
        },
        {
            id: 'control-a-naming-nit',
            checks: 'Drops a naming preference below the default threshold (control: must drop)',
            findings: [STYLE_NIT],
            owed: ['removed'],
        },
    ],
    verify: [
        {
            id: 'control-a-real-bug',
            checks: 'Keeps a finding the code confirms (control: must keep)',
            findings: [OFF_BY_ONE],
            owed: ['kept'],
        },
        {
            id: 'control-a-false-claim',
            checks: 'Drops a finding the code refutes (control: must drop)',
            findings: [FALSE_CLAIM],
            owed: ['removed'],
        },
    ],
};

// A control's outcome from the indexes of its findings that came out.
function scoreControl(control, out) {
    if (control.survivors !== undefined) {
        const ok = out.size === control.survivors;
        return { hits: ok ? 1 : 0, total: 1, detail: [{ what: `${control.survivors} of ${control.findings.length} findings come out (${out.size} did)`, ok }] };
    }
    const detail = control.findings.map((f, k) => ({
        what: `${control.owed[k] === 'kept' ? 'keeps' : 'drops'}: ${f.oneSentenceSummary}`,
        ok: control.owed[k] === 'kept' ? out.has(k) : !out.has(k),
    }));
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

module.exports = { CONTROLS, CONTROL_PR: PR, scoreControl };
