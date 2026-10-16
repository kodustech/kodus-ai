// The cases of the conversation eval: a developer answers a Kody comment in a
// PR thread, and Kody replies with the repository at the PR's head in its
// sandbox. Written for the eval with invented code, after the replies
// production threads carry most (kodus_agent_sessions, BigQuery mirror,
// 2026-10-15): "Fixed in <sha>", "Declined: <reason>", "Not valid: <reason>",
// and a question, in English and in Portuguese.
//
// Each case comes as a pair whose only difference is whether the developer is
// right, so Kody has to read the code to answer: a fix that landed and one that
// did not, a decline that holds and one that does not.
//
// A case: `repo` every file at the PR's head; `kodyComment` the comment the
// developer answers, on `file` with its `diffHunk`; `reply` the developer's
// message; `language` the team's language_config; `golden` what Kody's reply
// must assert, read by the judge (assertsClaim, evals/investigation/recall-judge.js).
const INVOICE_FIXED = `import { Order } from './types';

export function formatInvoice(order: Order): string {
    if (!order.customer) {
        return \`Invoice \${order.id}: no customer on file\`;
    }
    return \`Invoice \${order.id} for \${order.customer.name}\`;
}

export function formatReceipt(order: Order): string {
    return \`Receipt \${order.id}\`;
}
`;
const INVOICE_NOT_FIXED = `import { Order } from './types';

export function formatInvoice(order: Order): string {
    return \`Invoice \${order.id} for \${order.customer.name}\`;
}

export function formatReceipt(order: Order): string {
    if (!order.customer) {
        return \`Receipt \${order.id}\`;
    }
    return \`Receipt \${order.id} for \${order.customer.name}\`;
}
`;
const ORDER_TYPES = `export interface Customer {
    name: string;
}

export interface Order {
    id: string;
    // Orders created by the import job have no customer.
    customer?: Customer;
}
`;
const INVOICE_COMMENT = {
    file: 'src/billing/invoice.ts',
    diffHunk: '@@ -1,5 +1,5 @@\n export function formatInvoice(order: Order): string {\n+    return `Invoice ${order.id} for ${order.customer.name}`;\n }',
    text: '`formatInvoice` reads `order.customer.name` without checking `order.customer`. Orders created by the import job have no customer, so this throws a TypeError for them.',
};

const ANALYTICS = `type Event = { name: string; props?: Record<string, unknown> };

const queue: Event[] = [];

export const analytics = {
    // Queues the event for the background flusher. Never throws.
    track(name: string, props?: Record<string, unknown>): void {
        queue.push({ name, props });
    },
};
`;
const SIGNUP = `import { analytics } from './analytics';
import { users } from './users';

export async function signUp(email: string) {
    const user = await users.create(email);
    analytics.track('signed_up', { userId: user.id });
    return user;
}
`;
const USERS = `export const users = {
    async create(email: string) {
        return { id: 'u_1', email };
    },
};
`;

const ORDERS_ROUTE = `import { Router } from 'express';
import { db } from '../db';

export const ordersRouter = Router();

ordersRouter.get('/orders', async (req, res) => {
    const customer = String(req.query.customer ?? '');
    const rows = await db.query(\`SELECT * FROM orders WHERE customer_id = '\${customer}'\`);
    res.json(rows);
});
`;
const ORDERS_ROUTE_SAFE = `import { Router } from 'express';
import { db } from '../db';

export const ordersRouter = Router();

ordersRouter.get('/orders', async (req, res) => {
    const customer = String(req.query.customer ?? '');
    if (!/^cus_[a-z0-9]{8}$/.test(customer)) {
        res.status(400).json({ error: 'invalid customer id' });
        return;
    }
    const rows = await db.query('SELECT * FROM orders WHERE customer_id = $1', [customer]);
    res.json(rows);
});
`;
const DB = `export const db = {
    async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
        return [];
    },
};
`;
const SQL_COMMENT = {
    file: 'src/routes/orders.ts',
    diffHunk: "@@ -6,4 +6,5 @@\n+    const customer = String(req.query.customer ?? '');\n+    const rows = await db.query(`SELECT * FROM orders WHERE customer_id = '${customer}'`);",
    text: 'The orders lookup interpolates `req.query.customer` into the SQL string, so a crafted `customer` value can inject SQL.',
};

const RETRY = `const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;

export function retryDelay(attempt: number): number {
    return BASE_DELAY_MS * 2 ** attempt;
}

export async function scheduleRetry(job: { id: string }, attempt: number): Promise<void> {
    setTimeout(() => run(job, attempt + 1), retryDelay(attempt));
}

async function run(job: { id: string }, attempt: number): Promise<void> {
    try {
        await process(job);
    } catch {
        await scheduleRetry(job, attempt);
    }
}

async function process(job: { id: string }): Promise<void> {}
`;

const CASES = [
    {
        id: 'fixed-and-it-is',
        kind: 'claims a fix',
        checks: 'Confirms a fix the developer claims when the code at the head has it',
        language: 'en-US',
        repo: { 'src/billing/invoice.ts': INVOICE_FIXED, 'src/billing/types.ts': ORDER_TYPES },
        kodyComment: INVOICE_COMMENT,
        reply: 'Fixed in 4f2a91c.',
        golden: 'The fix is in place: formatInvoice now handles an order with no customer before reading its name.',
    },
    {
        id: 'fixed-but-it-is-not',
        kind: 'claims a fix',
        checks: 'Says the issue is still there when the claimed fix landed in another function',
        language: 'en-US',
        repo: { 'src/billing/invoice.ts': INVOICE_NOT_FIXED, 'src/billing/types.ts': ORDER_TYPES },
        kodyComment: INVOICE_COMMENT,
        reply: 'Fixed in 4f2a91c.',
        golden: 'The issue is still present: formatInvoice still reads order.customer.name without checking order.customer; the guard was added to formatReceipt instead.',
    },
    {
        id: 'decline-that-holds',
        kind: 'declines',
        checks: 'Accepts a decline the code proves right (the call it flagged is synchronous)',
        language: 'en-US',
        repo: { 'src/analytics.ts': ANALYTICS, 'src/signup.ts': SIGNUP, 'src/users.ts': USERS },
        kodyComment: {
            file: 'src/signup.ts',
            diffHunk: "@@ -5,3 +5,4 @@\n     const user = await users.create(email);\n+    analytics.track('signed_up', { userId: user.id });",
            text: '`analytics.track(...)` is not awaited, so if it rejects the error is lost and the sign-up still returns as if it succeeded.',
        },
        reply: 'Declined: track is synchronous and returns void. It only queues the event and never throws, so there is nothing to await.',
        golden: 'The developer is right: analytics.track is synchronous, returns void and never throws, so there is nothing to await and the comment does not apply.',
    },
    {
        id: 'decline-that-does-not-hold',
        kind: 'declines',
        checks: 'Holds its ground when a decline claims validation the code does not have',
        language: 'en-US',
        repo: { 'src/routes/orders.ts': ORDERS_ROUTE, 'src/db.ts': DB },
        kodyComment: SQL_COMMENT,
        reply: 'Not valid: the customer id is validated before it reaches this route.',
        golden: 'The concern stands: nothing in the code validates or parameterizes the customer value before it is interpolated into the SQL query.',
    },
    {
        id: 'decline-after-the-fix',
        kind: 'declines',
        checks: 'Accepts that the comment no longer applies when the head validates and parameterizes the value',
        language: 'en-US',
        repo: { 'src/routes/orders.ts': ORDERS_ROUTE_SAFE, 'src/db.ts': DB },
        kodyComment: SQL_COMMENT,
        reply: 'Not valid anymore: the id is validated and the query is parameterized now.',
        golden: 'The comment no longer applies: the customer id is validated and the query now uses a parameter instead of interpolation.',
    },
    {
        id: 'question-the-cap',
        kind: 'asks',
        checks: 'Answers a question by showing in the code that the attempt cap the developer cites is never applied',
        language: 'en-US',
        repo: { 'src/queue/retry.ts': RETRY },
        kodyComment: {
            file: 'src/queue/retry.ts',
            diffHunk: '@@ -4,3 +4,3 @@\n export function retryDelay(attempt: number): number {\n+    return BASE_DELAY_MS * 2 ** attempt;',
            text: '`retryDelay` grows without bound: a job that keeps failing waits longer every time, past an hour by attempt 12, and is retried forever.',
        },
        reply: '@kody why is that a problem? We cap attempts at 5.',
        golden: 'MAX_ATTEMPTS is defined but never checked: run calls scheduleRetry again on every failure without comparing the attempt to MAX_ATTEMPTS, so the job is retried forever with a growing delay.',
    },
    {
        id: 'pt-fixed-and-it-is',
        kind: 'claims a fix',
        checks: 'Confirms in Portuguese a fix claimed in Portuguese, when the code at the head has it',
        language: 'pt-BR',
        repo: { 'src/billing/invoice.ts': INVOICE_FIXED, 'src/billing/types.ts': ORDER_TYPES },
        kodyComment: INVOICE_COMMENT,
        reply: 'Corrigido em 4f2a91c.',
        golden: 'The fix is in place: formatInvoice now handles an order with no customer before reading its name.',
    },
    {
        id: 'pt-decline-that-does-not-hold',
        kind: 'declines',
        checks: 'Holds its ground in Portuguese when a decline claims validation the code does not have',
        language: 'pt-BR',
        repo: { 'src/routes/orders.ts': ORDERS_ROUTE, 'src/db.ts': DB },
        kodyComment: SQL_COMMENT,
        reply: 'Não procede, o id do cliente já é validado antes de chegar nessa rota.',
        golden: 'The concern stands: nothing in the code validates or parameterizes the customer value before it is interpolated into the SQL query.',
    },
];

module.exports = { CASES };
