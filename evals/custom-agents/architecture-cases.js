// P13 Architecture template: the built-in Architecture agent, saved unchanged
// from the New agent dialog, flags a domain module that depends on the web
// layer and a controller that computes a business rule itself, and stays quiet
// on the same changes written right (controls). The instructions are read from
// the web app's templates, the text the dialog and the CLI hand a team, so a
// template edit is what this eval measures.
// Invented domain: a subscription team's quotes and renewals.

const fs = require('fs');
const path = require('path');

// EVAL_TEMPLATES_FILE scores another revision's templates on the same cases
// (a baseline: `git show <ref>:<this path> > /tmp/drafts.ts`).
const TEMPLATES_FILE =
    process.env.EVAL_TEMPLATES_FILE ||
    path.join(
        __dirname,
        '../../apps/web/src/lib/services/custom-agents/drafts.ts',
    );

// A one-line string literal in either quote style.
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/;

function literal(text) {
    if (text.startsWith('"')) return JSON.parse(text);
    return text.slice(1, -1).replace(/\\(['"\\])/g, '$1');
}

/** The template's name and instructions, read from the web app's source. */
function readTemplate(id) {
    const source = fs.readFileSync(TEMPLATES_FILE, 'utf8');
    const start = source.indexOf(`id: "${id}",`);
    if (start < 0) throw new Error(`template ${id} not found in drafts.ts`);
    const block = source.slice(start, source.indexOf('].join("\\n")', start));
    const name = literal(
        block.match(new RegExp(`name: (${STRING.source})`))[1],
    );
    const list = block.slice(block.indexOf('instructions: ['));
    const lines = [
        ...list.matchAll(new RegExp(`^\\s+(${STRING.source}),$`, 'gm')),
    ].map((m) => literal(m[1]));
    if (!lines.length) throw new Error(`template ${id} has no instructions`);
    return { name, instructions: lines.join('\n') };
}

const { name, instructions } = readTemplate('architecture');
const agent = {
    id: 'template-architecture',
    name,
    enabled: true,
    instructions,
    scope: {},
    tools: {},
    presentation: {
        tag: { color: '#2563eb' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
};

const LAYER =
    /layer|domain|http|express|request|framework|depend|import|boundar/i;
const BUSINESS = /controller|service|layer|business|pricing|belongs in/i;

const DOMAIN_PRICING_TS = `/** Pure pricing rules: no framework, no I/O. */
export function lineTotal(unitCents: number, quantity: number): number {
    return unitCents * quantity;
}
`;

const QUOTES_BEFORE = `import { lineTotal } from '../domain/pricing';

export function quote(req: any, res: any) {
    res.json({ totalCents: lineTotal(Number(req.query.unitCents), Number(req.query.quantity)) });
}
`;

const RENEWAL_PRICING_TS = `export interface Plan {
    priceCents: number;
}

/** Loyal customers renew at 90% of the plan price, rounded down to a cent. */
export function renewalPriceCents(plan: Plan, loyal: boolean): number {
    return loyal ? Math.floor((plan.priceCents * 90) / 100) : plan.priceCents;
}
`;

const RENEWALS_BEFORE = `import { renewalPriceCents } from '../services/pricing';

export function renewalQuote(req: any, res: any) {
    const { plan, loyal } = req.body;
    res.json({ priceCents: renewalPriceCents(plan, loyal) });
}
`;

const ARCHITECTURE_CASES = [
    {
        id: 'architecture-domain-imports-http',
        checks: 'The Architecture template flags a domain rule that takes the express request, where the rest of the domain is framework-free',
        team: { agent },
        prTitle: 'Discount codes',
        prBody: 'Quotes accept a discount code.',
        before: { 'src/domain/discounts.ts': null },
        repo: {
            'src/domain/pricing.ts': DOMAIN_PRICING_TS,
            'src/http/quotes.controller.ts': QUOTES_BEFORE,
            'src/domain/discounts.ts': `import type { Request } from 'express';

export function discountPercent(req: Request): number {
    return req.query.code === 'SPRING10' ? 10 : 0;
}
`,
        },
        expect: [
            {
                property: 'P13',
                flag: 'src/domain/discounts.ts',
                at: "import type { Request } from 'express';",
                about: LAYER,
            },
        ],
    },
    {
        id: 'architecture-controller-maps-input',
        checks: 'The Architecture template stays quiet when the controller only maps the query and the domain computes the discount (control)',
        team: { agent },
        prTitle: 'Discount codes',
        prBody: 'Quotes accept a discount code.',
        before: {
            'src/domain/discounts.ts': null,
            'src/http/quotes.controller.ts': QUOTES_BEFORE,
        },
        repo: {
            'src/domain/pricing.ts': DOMAIN_PRICING_TS,
            'src/domain/discounts.ts': `export function discountedTotal(totalCents: number, code: string | undefined): number {
    const percent = code === 'SPRING10' ? 10 : 0;
    return totalCents - Math.floor((totalCents * percent) / 100);
}
`,
            'src/http/quotes.controller.ts': `import { lineTotal } from '../domain/pricing';
import { discountedTotal } from '../domain/discounts';

export function quote(req: any, res: any) {
    const total = lineTotal(Number(req.query.unitCents), Number(req.query.quantity));
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    res.json({ totalCents: discountedTotal(total, code) });
}
`,
        },
        expect: [
            {
                property: 'P13',
                quiet: 'src/http/quotes.controller.ts',
                about: LAYER,
            },
        ],
    },
    {
        id: 'architecture-logic-in-controller',
        checks: 'The Architecture template flags a controller that recomputes the renewal discount the pricing service owns, and leaves alone an off-by-one loop in the same file',
        team: { agent },
        prTitle: 'Renewal quote shows each add-on',
        prBody: 'The quote lists add-ons and applies the loyalty discount.',
        before: { 'src/controllers/renewals.controller.ts': RENEWALS_BEFORE },
        repo: {
            'src/services/pricing.ts': RENEWAL_PRICING_TS,
            'src/controllers/renewals.controller.ts': `export function renewalQuote(req: any, res: any) {
    const { plan, loyal, addOns } = req.body;
    let priceCents = plan.priceCents;
    if (loyal) {
        priceCents = Math.floor((priceCents * 90) / 100);
    }
    const lines: string[] = [];
    for (let i = 0; i <= addOns.length; i++) {
        lines.push(addOns[i].name);
    }
    res.json({ priceCents, lines });
}
`,
        },
        expect: [
            {
                property: 'P13',
                flag: 'src/controllers/renewals.controller.ts',
                at: 'priceCents = Math.floor((priceCents * 90) / 100);',
                about: BUSINESS,
            },
            {
                property: 'P2',
                quiet: 'src/controllers/renewals.controller.ts',
                at: 'i <= addOns.length',
                within: 1,
            },
        ],
    },
    {
        id: 'architecture-controller-delegates',
        checks: 'The Architecture template stays quiet on a controller that keeps delegating the price to the pricing service (control)',
        team: { agent },
        prTitle: 'Renewal quote shows each add-on',
        prBody: 'The quote lists add-ons next to the price.',
        before: { 'src/controllers/renewals.controller.ts': RENEWALS_BEFORE },
        repo: {
            'src/services/pricing.ts': RENEWAL_PRICING_TS,
            'src/controllers/renewals.controller.ts': `import { renewalPriceCents } from '../services/pricing';

export function renewalQuote(req: any, res: any) {
    const { plan, loyal, addOns } = req.body;
    res.json({
        priceCents: renewalPriceCents(plan, loyal),
        lines: addOns.map((addOn: { name: string }) => addOn.name),
    });
}
`,
        },
        expect: [
            {
                property: 'P13',
                quiet: 'src/controllers/renewals.controller.ts',
                about: BUSINESS,
            },
        ],
    },
];

module.exports = { ARCHITECTURE_CASES, readTemplate };
