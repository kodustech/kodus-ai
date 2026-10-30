// The cases of the custom-agents eval: small pull requests on repositories
// written for the eval (invented domains), each reviewed by a team that set up
// one custom agent. Every check names the property of the feature it holds
// (README.md, "Properties"):
//   P1  in-lane: the agent flags what its instructions ask for in its scope
//       (`flag`), and stays quiet on code that follows them (a control)
//   P2  lane-only: it posts nothing on a real defect its instructions are not
//       about (the generalist's job), next to a case where it does act
//   P3  scope: it posts nothing on a file outside its globs, even one holding
//       the very violation it flags inside them
//   P4  an include glob that names files explicitly reaches a file the team's
//       ignorePaths set aside
//   P7  a disabled agent does not run
//
// A case is a pull request: `repo` is every file at the PR's head, `before` the
// files the PR changed as they were (null = added). `team` is what the team
// saved: the agent the case scores (`agent`), any other agent it saved
// (`others`), both in codeReviewConfig.customAgents, and the paths it adds to
// production's default ignorePaths (`ignore`). `expect` lists what the agent
// owes on a file: `flag` a finding `about` the topic (a pattern on its text)
// near the line holding `at`; `quiet` no finding there (`about` omitted: on any
// topic; `at` omitted: anywhere in the file). Only the agent's own findings
// count (the `customAgent` stamp production puts on them).
//
// `dispatch` checks what the review handed an agent, read off the agent loops
// production ran: `gets` a file among its files, `never` a file outside them,
// `runs: false` no loop and no finding at all. They need no model's judgement,
// so they hold the same under the scripted model (evals/wiring-smoke.js), where
// a break of the scope, the ignored-file reach or the enabled switch shows on
// every PR.

const presentation = {
    tag: { color: '#2563eb' },
    format: 'inline',
    suggestedFix: 'when-confident',
};

const MONEY_AGENT = {
    id: 'agent-money',
    name: 'Money Handling',
    enabled: true,
    instructions: [
        'Billing code keeps money as integer cents: amounts are `number` fields named `*Cents`.',
        'Flag floating-point arithmetic on money: `parseFloat` or `Number()` on an amount, multiplying or dividing an amount by a decimal factor (such as `* 1.08` for tax or `* 0.9` for a discount), or `toFixed` to round money.',
        'Money math goes through the helpers in `src/billing/money.ts` (`addCents`, `percentOfCents`).',
    ].join('\n'),
    scope: { include: ['src/billing/**'] },
    tools: {},
    presentation,
};

const API_ERRORS_AGENT = {
    id: 'agent-api-errors',
    name: 'API Errors',
    enabled: true,
    instructions: [
        'HTTP handlers under `src/api/` report failures with `sendError(res, status, code)` from `src/api/errors.ts`, which logs the cause and answers `{ error: code }`.',
        "Flag a handler that sends an exception's message or stack, or the raw error object, to the client (for example `res.status(500).send(err.message)` or `res.json({ error: err })`).",
        'Flag a handler that answers a failure with status 200.',
    ].join('\n'),
    scope: { include: ['src/api/**'] },
    tools: {},
    presentation,
};

const MIGRATIONS_AGENT = {
    id: 'agent-migrations',
    name: 'Migration Safety',
    enabled: true,
    instructions: [
        'Review database migrations.',
        'A migration that adds a column to an existing table as NOT NULL must give it a DEFAULT (or backfill it first): on a table that has rows the ALTER fails and blocks the deploy.',
        "Every migration's `down` must undo what its `up` does.",
    ].join('\n'),
    // A literal directory and a last segment that says which files: the glob
    // names these files, so it reaches them even where the team's ignorePaths
    // set them aside (#37). A bare folder, `db/migrations/**`, would not.
    scope: { include: ['db/migrations/**/*.ts'] },
    tools: {},
    presentation,
};

// A second money agent the team saved and switched off: same scope, so only
// `enabled: false` keeps it from running.
const MONEY_DRAFT_AGENT = {
    ...MONEY_AGENT,
    id: 'agent-money-draft',
    name: 'Money Handling Draft',
    enabled: false,
};

// Topics a finding is about, matched on its summary and text.
const MONEY =
    /float|parseFloat|Number\(|toFixed|decimal|cents|integer|round|precision|money|percentOfCents|addCents/i;
const ERROR_LEAK =
    /message|stack|leak|expos|internal|sendError|raw error|error object|status 200|200/i;
const NOT_NULL = /default|not null|backfill|existing rows|rows|fail/i;
const DOWN = /down|revert|undo|rollback|roll back/i;

const MONEY_TS = `export function addCents(a: number, b: number): number {
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('cents must be integers');
    return a + b;
}

/** \`percent\` of \`cents\`, rounded half up to a whole cent. */
export function percentOfCents(cents: number, percent: number): number {
    return Math.floor((cents * Math.round(percent * 100) + 5000) / 10000);
}
`;

const INVOICE_BEFORE = `import { addCents, percentOfCents } from './money';

export interface InvoiceLine {
    description: string;
    unitPriceCents: number;
    quantity: number;
}

export function invoiceTotalCents(lines: InvoiceLine[], taxRatePercent: number): number {
    const subtotal = lines.reduce((sum, line) => addCents(sum, line.unitPriceCents * line.quantity), 0);
    return addCents(subtotal, percentOfCents(subtotal, taxRatePercent));
}

export function describeLines(lines: InvoiceLine[]): string[] {
    return lines.map((line, i) => \`\${i + 1}. \${line.description.trim()}\`);
}
`;

const ERRORS_TS = `import type { Response } from 'express';

import { logger } from '../logger';

export function sendError(res: Response, status: number, code: string, cause?: unknown): void {
    if (cause) logger.error({ code, cause });
    res.status(status).json({ error: code });
}
`;

const LOGGER_TS = `export const logger = {
    error(entry: Record<string, unknown>): void {
        console.error(JSON.stringify(entry));
    },
};
`;

const ORDERS_STORE = `export interface Order {
    id: string;
    customerId: string;
    status: 'open' | 'cancelled';
}

const rows: Order[] = [];

export const orders = {
    async find(id: string): Promise<Order | undefined> {
        return rows.find((o) => o.id === id);
    },
    async list(): Promise<Order[]> {
        return [...rows];
    },
    async cancel(id: string): Promise<void> {
        const order = rows.find((o) => o.id === id);
        if (!order) throw new Error(\`order \${id} vanished while cancelling\`);
        order.status = 'cancelled';
    },
};
`;

const ORDERS_ROUTES_BEFORE = `import { Router } from 'express';

import { orders } from '../orders/store';
import { sendError } from './errors';

export const router = Router();

router.get('/orders/:id', async (req, res) => {
    const order = await orders.find(req.params.id);
    if (!order) return sendError(res, 404, 'order_not_found');
    res.json(order);
});
`;

const MIGRATION_TYPES = `export interface Db {
    execute(sql: string): Promise<void>;
}

export interface Migration {
    up(db: Db): Promise<void>;
    down(db: Db): Promise<void>;
}
`;

const MIGRATION_0006 = `import type { Migration } from '../migration';

export const migration: Migration = {
    async up(db) {
        await db.execute(\`CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL)\`);
    },
    async down(db) {
        await db.execute(\`DROP TABLE orders\`);
    },
};
`;

const ORDER_STATUS_BEFORE = `export type OrderStatus = 'open' | 'cancelled';
`;
const ORDER_STATUS_AFTER = `export type OrderStatus = 'pending' | 'open' | 'cancelled';

export const INITIAL_STATUS: OrderStatus = 'pending';
`;

const CASES = [
    {
        id: 'money-float-tax',
        checks: 'The money agent flags tax computed in floating point in billing code, and leaves alone a loop bug its instructions are not about',
        team: { agent: MONEY_AGENT, others: [MONEY_DRAFT_AGENT] },
        prTitle: 'Round invoice totals and number the lines',
        prBody: 'Totals now round to two decimals; line descriptions are numbered in a loop.',
        before: { 'src/billing/invoice.ts': INVOICE_BEFORE },
        repo: {
            'src/billing/money.ts': MONEY_TS,
            'src/billing/invoice.ts': `import { addCents } from './money';

export interface InvoiceLine {
    description: string;
    unitPriceCents: number;
    quantity: number;
}

export function invoiceTotalCents(lines: InvoiceLine[], taxRatePercent: number): number {
    const subtotal = lines.reduce((sum, line) => addCents(sum, line.unitPriceCents * line.quantity), 0);
    const total = parseFloat((subtotal * (1 + taxRatePercent / 100)).toFixed(2));
    return total;
}

export function describeLines(lines: InvoiceLine[]): string[] {
    const out: string[] = [];
    for (let i = 0; i <= lines.length; i++) {
        out.push(\`\${i + 1}. \${lines[i].description.trim()}\`);
    }
    return out;
}
`,
        },
        expect: [
            {
                property: 'P1',
                flag: 'src/billing/invoice.ts',
                at: 'parseFloat(',
                about: MONEY,
            },
            {
                property: 'P2',
                quiet: 'src/billing/invoice.ts',
                at: 'i <= lines.length',
                within: 1,
            },
            { property: 'P7', dispatch: 'agent-money-draft', runs: false },
        ],
    },
    {
        id: 'money-discount-decimal',
        checks: 'The money agent flags a discount applied by multiplying cents by a decimal factor',
        team: { agent: MONEY_AGENT },
        prTitle: 'Loyalty discount on renewals',
        prBody: 'Renewing customers get 10% off.',
        before: { 'src/billing/renewal.ts': null },
        repo: {
            'src/billing/money.ts': MONEY_TS,
            'src/billing/renewal.ts': `export interface Renewal {
    planPriceCents: number;
    loyal: boolean;
}

export function renewalPriceCents(renewal: Renewal): number {
    if (!renewal.loyal) return renewal.planPriceCents;
    return renewal.planPriceCents * 0.9;
}
`,
        },
        expect: [
            {
                property: 'P1',
                flag: 'src/billing/renewal.ts',
                at: '* 0.9',
                about: MONEY,
            },
        ],
    },
    {
        id: 'money-cents-helpers',
        checks: 'The money agent stays quiet on billing code that keeps to integer cents through the helpers (control)',
        team: { agent: MONEY_AGENT },
        prTitle: 'Discount codes on invoices',
        prBody: 'A discount code takes a percentage off the subtotal.',
        before: { 'src/billing/invoice.ts': INVOICE_BEFORE },
        repo: {
            'src/billing/money.ts': MONEY_TS,
            'src/billing/invoice.ts': `import { addCents, percentOfCents } from './money';

export interface InvoiceLine {
    description: string;
    unitPriceCents: number;
    quantity: number;
}

export function invoiceTotalCents(lines: InvoiceLine[], taxRatePercent: number, discountPercent = 0): number {
    const subtotal = lines.reduce((sum, line) => addCents(sum, line.unitPriceCents * line.quantity), 0);
    const discounted = addCents(subtotal, -percentOfCents(subtotal, discountPercent));
    return addCents(discounted, percentOfCents(discounted, taxRatePercent));
}

export function describeLines(lines: InvoiceLine[]): string[] {
    return lines.map((line, i) => \`\${i + 1}. \${line.description.trim()}\`);
}
`,
        },
        expect: [
            { property: 'P1', quiet: 'src/billing/invoice.ts', about: MONEY },
        ],
    },
    {
        id: 'money-out-of-scope',
        checks: 'The money agent posts nothing on a report outside src/billing that does float math on money, while it reviews the billing file the same PR changes',
        team: { agent: MONEY_AGENT },
        prTitle: 'Revenue report with VAT, and invoice line numbering',
        prBody: 'The revenue export adds VAT to each row.',
        before: {
            'src/reports/revenue.ts': null,
            'src/billing/invoice.ts': INVOICE_BEFORE,
        },
        repo: {
            'src/billing/money.ts': MONEY_TS,
            'src/billing/invoice.ts': INVOICE_BEFORE.replace(
                '`${i + 1}. ',
                '`#${i + 1} ',
            ),
            'src/reports/revenue.ts': `export interface RevenueRow {
    month: string;
    amount: string;
}

export function withVat(rows: RevenueRow[]): Array<{ month: string; gross: number }> {
    return rows.map((row) => ({ month: row.month, gross: parseFloat(row.amount) * 1.2 }));
}
`,
        },
        expect: [
            { property: 'P3', quiet: 'src/reports/revenue.ts' },
            {
                property: 'P3',
                dispatch: 'agent-money',
                never: 'src/reports/revenue.ts',
            },
            { property: 'P1', quiet: 'src/billing/invoice.ts', about: MONEY },
        ],
    },
    {
        id: 'api-error-leak',
        checks: "The API errors agent flags a handler that sends the exception's message, and stays off a paging bug and off the same leak outside src/api",
        team: { agent: API_ERRORS_AGENT },
        prTitle: 'Cancel orders, page the order list, admin export',
        prBody: 'Adds the cancel endpoint, pages the list, and an admin CSV export.',
        before: {
            'src/api/orders.ts': ORDERS_ROUTES_BEFORE,
            'src/admin/export.ts': null,
        },
        repo: {
            'src/api/errors.ts': ERRORS_TS,
            'src/logger.ts': LOGGER_TS,
            'src/orders/store.ts': ORDERS_STORE,
            'src/api/orders.ts': `import { Router } from 'express';

import { orders } from '../orders/store';
import { sendError } from './errors';

export const router = Router();

router.get('/orders/:id', async (req, res) => {
    const order = await orders.find(req.params.id);
    if (!order) return sendError(res, 404, 'order_not_found');
    res.json(order);
});

router.post('/orders/:id/cancel', async (req, res) => {
    const order = await orders.find(req.params.id);
    if (!order) return sendError(res, 404, 'order_not_found');
    try {
        await orders.cancel(order.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).send((err as Error).message);
    }
});

router.get('/orders', async (req, res) => {
    const limit = Number(req.query.limit ?? 20);
    const offset = Number(req.query.offset ?? 0);
    const all = await orders.list();
    const page = all.slice(offset, offset + limit - 1);
    res.json({ items: page, total: all.length });
});
`,
            'src/admin/export.ts': `import type { Request, Response } from 'express';

import { orders } from '../orders/store';

export async function exportOrders(_req: Request, res: Response): Promise<void> {
    try {
        const rows = await orders.list();
        res.type('text/csv').send(rows.map((o) => \`\${o.id},\${o.status}\`).join('\\n'));
    } catch (err) {
        res.status(500).send((err as Error).stack);
    }
}
`,
        },
        expect: [
            {
                property: 'P1',
                flag: 'src/api/orders.ts',
                at: '.send((err as Error).message)',
                about: ERROR_LEAK,
            },
            {
                property: 'P2',
                quiet: 'src/api/orders.ts',
                at: 'offset + limit - 1',
                within: 1,
            },
            { property: 'P3', quiet: 'src/admin/export.ts' },
            {
                property: 'P3',
                dispatch: 'agent-api-errors',
                never: 'src/admin/export.ts',
            },
        ],
    },
    {
        id: 'api-only-general-bug',
        checks: 'The API errors agent posts nothing on a handler whose only defect is a paging bug its instructions are not about',
        team: { agent: API_ERRORS_AGENT },
        prTitle: 'Page the order list',
        prBody: 'The order list takes limit and offset.',
        before: { 'src/api/orders.ts': ORDERS_ROUTES_BEFORE },
        repo: {
            'src/api/errors.ts': ERRORS_TS,
            'src/logger.ts': LOGGER_TS,
            'src/orders/store.ts': ORDERS_STORE,
            'src/api/orders.ts': `${ORDERS_ROUTES_BEFORE}
router.get('/orders', async (req, res) => {
    const limit = Number(req.query.limit ?? 20);
    const offset = Number(req.query.offset ?? 0);
    const all = await orders.list();
    const page = all.slice(offset + 1, offset + limit);
    res.json({ items: page, total: all.length });
});
`,
        },
        expect: [{ property: 'P2', quiet: 'src/api/orders.ts' }],
    },
    {
        id: 'api-error-contract',
        checks: 'The API errors agent stays quiet on a handler that reports its failure through sendError (control)',
        team: { agent: API_ERRORS_AGENT },
        prTitle: 'Cancel orders',
        prBody: 'Adds the cancel endpoint.',
        before: { 'src/api/orders.ts': ORDERS_ROUTES_BEFORE },
        repo: {
            'src/api/errors.ts': ERRORS_TS,
            'src/logger.ts': LOGGER_TS,
            'src/orders/store.ts': ORDERS_STORE,
            'src/api/orders.ts': `${ORDERS_ROUTES_BEFORE}
router.post('/orders/:id/cancel', async (req, res) => {
    const order = await orders.find(req.params.id);
    if (!order) return sendError(res, 404, 'order_not_found');
    try {
        await orders.cancel(order.id);
        res.json({ ok: true });
    } catch (err) {
        sendError(res, 500, 'cancel_failed', err);
    }
});
`,
        },
        expect: [
            { property: 'P1', quiet: 'src/api/orders.ts', about: ERROR_LEAK },
        ],
    },
    {
        id: 'migration-not-null-ignored',
        checks: 'The migrations agent flags a NOT NULL column without a default in an ignored migration, and posts nothing on the same ALTER outside its globs',
        team: { agent: MIGRATIONS_AGENT, ignore: ['db/migrations/**'] },
        prTitle: 'Order status column',
        prBody: 'Orders get a status; new orders start as pending.',
        before: {
            'db/migrations/0007_order_status.ts': null,
            'scripts/hotfix-status.ts': null,
            'src/orders/status.ts': ORDER_STATUS_BEFORE,
        },
        repo: {
            'db/migration.ts': MIGRATION_TYPES,
            'db/migrations/0006_orders.ts': MIGRATION_0006,
            'db/migrations/0007_order_status.ts': `import type { Migration } from '../migration';

export const migration: Migration = {
    async up(db) {
        await db.execute(\`ALTER TABLE orders ADD COLUMN status TEXT NOT NULL\`);
    },
    async down(db) {
        await db.execute(\`ALTER TABLE orders DROP COLUMN status\`);
    },
};
`,
            'scripts/hotfix-status.ts': `import type { Db } from '../db/migration';

export async function hotfix(db: Db): Promise<void> {
    await db.execute(\`ALTER TABLE orders ADD COLUMN status TEXT NOT NULL\`);
}
`,
            'src/orders/status.ts': ORDER_STATUS_AFTER,
        },
        expect: [
            {
                property: 'P4',
                flag: 'db/migrations/0007_order_status.ts',
                at: 'ADD COLUMN status',
                about: NOT_NULL,
            },
            {
                property: 'P4',
                dispatch: 'agent-migrations',
                gets: 'db/migrations/0007_order_status.ts',
            },
            { property: 'P3', quiet: 'scripts/hotfix-status.ts' },
            {
                property: 'P3',
                dispatch: 'agent-migrations',
                never: 'scripts/hotfix-status.ts',
            },
        ],
    },
    {
        id: 'migration-down-ignored',
        checks: 'The migrations agent flags a down that does not undo its up, in a migration the team ignores',
        team: { agent: MIGRATIONS_AGENT, ignore: ['db/migrations/**'] },
        prTitle: 'Index orders by customer',
        prBody: 'Speeds up the customer order history.',
        before: {
            'db/migrations/0007_orders_by_customer.ts': null,
            'src/orders/status.ts': ORDER_STATUS_BEFORE,
        },
        repo: {
            'db/migration.ts': MIGRATION_TYPES,
            'db/migrations/0006_orders.ts': MIGRATION_0006,
            'db/migrations/0007_orders_by_customer.ts': `import type { Migration } from '../migration';

export const migration: Migration = {
    async up(db) {
        await db.execute(\`CREATE INDEX orders_by_customer ON orders (customer_id)\`);
    },
    async down(db) {
        await db.execute(\`SELECT 1\`);
    },
};
`,
            'src/orders/status.ts': ORDER_STATUS_AFTER,
        },
        expect: [
            {
                property: 'P4',
                flag: 'db/migrations/0007_orders_by_customer.ts',
                at: 'SELECT 1',
                within: 4,
                about: DOWN,
            },
            {
                property: 'P4',
                dispatch: 'agent-migrations',
                gets: 'db/migrations/0007_orders_by_customer.ts',
            },
        ],
    },
    {
        id: 'migration-safe-ignored',
        checks: 'The migrations agent stays quiet on a NOT NULL column added with a default, in a migration the team ignores (control)',
        team: { agent: MIGRATIONS_AGENT, ignore: ['db/migrations/**'] },
        prTitle: 'Order status column',
        prBody: 'Orders get a status; existing orders become open.',
        before: {
            'db/migrations/0007_order_status.ts': null,
            'src/orders/status.ts': ORDER_STATUS_BEFORE,
        },
        repo: {
            'db/migration.ts': MIGRATION_TYPES,
            'db/migrations/0006_orders.ts': MIGRATION_0006,
            'db/migrations/0007_order_status.ts': `import type { Migration } from '../migration';

export const migration: Migration = {
    async up(db) {
        await db.execute(\`ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'open'\`);
    },
    async down(db) {
        await db.execute(\`ALTER TABLE orders DROP COLUMN status\`);
    },
};
`,
            'src/orders/status.ts': ORDER_STATUS_AFTER,
        },
        expect: [
            {
                property: 'P4',
                quiet: 'db/migrations/0007_order_status.ts',
                about: NOT_NULL,
            },
            {
                property: 'P4',
                dispatch: 'agent-migrations',
                gets: 'db/migrations/0007_order_status.ts',
            },
        ],
    },
];

module.exports = { CASES };
