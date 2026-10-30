// The cases of the memories eval. Each theme is a kind of memory production
// teams keep (BigQuery mirror, 2026-10-15: 437 active memories in 64 orgs),
// written for the eval with invented code:
//   - "do not flag X, it is intended": the most common kind
//   - a convention the team follows
//   - a fact about the codebase that changes what a change means
// Each theme comes as a pair: one case where the memory decides the answer,
// and one where it must not: a real bug the memory does not cover, or code
// that already follows the convention.
//
// A case is a pull request on a small repository: `repo` is every file at the
// PR's head, `before` the files the PR changed as they were (null = added).
// `expect` lists what the review owes on a file: `flag` a finding `about` the
// topic (a pattern on its text) near the line holding `at`, or `quiet` no
// finding about it there (no `at`: anywhere in the file). Other findings on the
// same file do not count either way.
//
// The memory has to decide the case: run with --no-memories, every case whose
// answer comes from the memory goes wrong, and only the cases a memory must not
// silence stay right.
const fixtures = {
    title: 'Test fixtures hold fake credentials',
    rule: 'Files under `test/fixtures/` hold API keys and tokens made up for tests. They are fake by design: do not flag them as leaked secrets.',
};
const reportsNoLimit = {
    title: 'Reports load whole periods',
    rule: 'Queries under `src/reports/` load every row of the period on purpose: the export must include all of them. Do not suggest LIMIT, pagination or capping the rows there.',
};
const internalAuth = {
    title: 'Internal routes are authenticated by the gateway',
    rule: 'Routes under `/internal/` are only reachable through the API gateway, which authenticates every request. Do not ask for authentication middleware on them.',
};
const configConvention = {
    title: 'Read configuration through config.get',
    rule: "Application code reads settings with `config.get('<key>')` from `src/config`. Never read `process.env` outside `src/config`.",
};
const generatedClient = {
    title: 'src/generated is generated from openapi.yaml',
    rule: '`src/generated/**` is generated from `openapi.yaml` by `npm run codegen` and overwritten on every build. A change there must come from a change to `openapi.yaml`.',
};

const CONFIG = `import { settings } from './settings';

export const config = {
    get(key: string): string {
        const value = settings[key];
        if (value === undefined) throw new Error(\`missing setting \${key}\`);
        return value;
    },
};
`;
const SETTINGS = `export const settings: Record<string, string> = {
    'smtp.host': process.env.SMTP_HOST ?? 'localhost',
    'smtp.user': process.env.SMTP_USER ?? '',
    'smtp.password': process.env.SMTP_PASSWORD ?? '',
};
`;

const DB = `export const db = {
    async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
        return [];
    },
};
`;

const OPENAPI_BEFORE = `openapi: 3.0.0
info:
  title: Orders API
  version: 1.0.0
paths: {}
components:
  schemas:
    Order:
      type: object
      required: [id, total]
      properties:
        id:
          type: string
        total:
          type: number
`;
const OPENAPI_AFTER = OPENAPI_BEFORE.replace(
    `        total:
          type: number
`,
    `        total:
          type: number
        currency:
          type: string
`,
);
const GENERATED_BEFORE = `export interface Order {
    id: string;
    total: number;
}
`;
const GENERATED_AFTER = `export interface Order {
    id: string;
    total: number;
    currency?: string;
}
`;
const ORDER_VIEW = `import { Order } from './generated/api-types';

export function formatOrder(order: Order): string {
    return \`\${order.id}: \${order.total.toFixed(2)} \${order.currency ?? ''}\`;
}
`;

// Topics a finding is about, matched on its summary and text.
const SECRET = /secret|token|credential|api.?key|leak|hard.?coded|exposed/i;
const AUTH = /authenticat|authoriz|\bauth\b|access control|unprotected/i;
const INJECTION = /inject|interpolat|parameteri|concatenat|sanitiz|escap/i;
const UNBOUNDED = /\blimit\b|paginat|unbounded|all rows|every row|whole table|memory|cap\b|batch(ing)? the/i;
const N_PLUS_ONE = /n\s*\+\s*1|per (row|customer|record)|each (row|customer|record)|inside the loop|in a loop|round.?trip|one query per|batch|join/i;
const CONVENTION = /config\.get|convention|src\/config|settings (layer|module)|team rule|centrali[sz]ed config/i;
const GENERATED = /generat|openapi|codegen|overwrit|by hand|manual(ly)? edit/i;

// Made-up credentials in the shape of real ones, assembled here so the source
// holds no literal a secret scanner would stop at the push.
const FAKE_SLACK_TOKEN = ['xoxb', '2817364591', '8473625190', 'Qm7sKd92LpXz4RtNv8Wc1Yhe'].join('-');
const FAKE_LIVE_KEY = ['sk', 'live', '51Hq8LmA9xKz2PqR7vT3nW8yB'].join('_');
// A TypeScript fixture, not JSON: production ignores **/*.json by default
// (default-kodus-config.yml ignorePaths), so it never reviews a JSON fixture
// and no memory would decide the case.
const SLACK_FIXTURE = `export const workspace = {
    team: 'T024BE7LD',
    botToken: '${FAKE_SLACK_TOKEN}',
    signingSecret: '8f742231b10e8888abcd99yyyzzz85a5',
    channel: 'C1H9RESGL',
};
`;

const CASES = [
    {
        id: 'fixtures-real-looking-token',
        theme: 'fixtures',
        checks: 'Stays quiet on a real-looking token in test/fixtures, which a memory says is fake by design',
        memories: [fixtures],
        prTitle: 'Add Slack workspace fixture',
        prBody: 'Fixture for the Slack notifier tests.',
        before: { 'test/fixtures/slack-workspace.ts': null },
        repo: {
            'test/fixtures/slack-workspace.ts': SLACK_FIXTURE,
            'test/slack-notifier.test.ts': `import { workspace } from './fixtures/slack-workspace';
import { notify } from '../src/slack-notifier';

it('posts to the channel', async () => {
    await notify(workspace, 'deploy done');
});
`,
            'src/slack-notifier.ts': `export async function notify(workspace: { botToken: string; channel: string }, text: string) {
    return { channel: workspace.channel, text };
}
`,
        },
        expect: [{ quiet: 'test/fixtures/slack-workspace.ts', about: SECRET }],
    },
    {
        id: 'fixtures-live-key-in-source',
        theme: 'fixtures',
        checks: 'Flags a live key committed in application code, which the fixtures memory does not cover',
        memories: [fixtures],
        prTitle: 'Wire the payment client',
        prBody: 'Creates the payment client used at checkout.',
        before: { 'src/payments/checkout.ts': null },
        repo: {
            'src/payments/checkout.ts': `import { createClient } from './client';

const client = createClient('${FAKE_LIVE_KEY}');

export async function charge(amount: number) {
    return { client, amount };
}
`,
            'src/payments/client.ts': `export function createClient(apiKey: string) {
    return { apiKey };
}
`,
            'test/fixtures/slack-workspace.ts': SLACK_FIXTURE,
        },
        expect: [{ flag: 'src/payments/checkout.ts', at: 'sk_live_', about: SECRET }],
    },
    {
        id: 'internal-route-no-auth',
        theme: 'internal-auth',
        checks: 'Asks for no auth on an /internal/ route, which a memory says the gateway authenticates',
        memories: [internalAuth],
        prTitle: 'Add internal endpoint to rebuild the search index',
        prBody: 'Ops trigger it from the admin console.',
        before: { 'src/routes/internal/reindex.ts': null },
        repo: {
            'src/routes/internal/reindex.ts': `import { Router } from 'express';
import { searchIndex } from '../../search/index';

export const reindexRouter = Router();

reindexRouter.post('/internal/reindex', async (_req, res) => {
    const count = await searchIndex.rebuild();
    res.json({ rebuilt: count });
});
`,
            'src/search/index.ts': `export const searchIndex = {
    async rebuild(): Promise<number> {
        return 0;
    },
};
`,
        },
        expect: [{ quiet: 'src/routes/internal/reindex.ts', about: AUTH }],
    },
    {
        id: 'internal-route-sql-injection',
        theme: 'internal-auth',
        checks: 'Flags SQL built from a query parameter on an /internal/ route, which the gateway memory does not cover',
        memories: [internalAuth],
        prTitle: 'Add internal endpoint to look up orders by customer',
        prBody: 'Support uses it from the admin console.',
        before: { 'src/routes/internal/orders.ts': null },
        repo: {
            'src/routes/internal/orders.ts': `import { Router } from 'express';
import { db } from '../../db';

export const ordersRouter = Router();

ordersRouter.get('/internal/orders', async (req, res) => {
    const customer = String(req.query.customer ?? '');
    const rows = await db.query(\`SELECT * FROM orders WHERE customer_id = '\${customer}'\`);
    res.json(rows);
});
`,
            'src/db.ts': DB,
        },
        expect: [{ flag: 'src/routes/internal/orders.ts', at: 'SELECT * FROM orders', about: INJECTION }],
    },
    {
        id: 'report-loads-whole-period',
        theme: 'reports',
        checks: 'Asks for no LIMIT on a report query that loads the whole period, which a memory says is on purpose',
        memories: [reportsNoLimit],
        prTitle: 'Export monthly usage',
        prBody: 'Finance needs every usage event of the month as CSV.',
        before: { 'src/reports/monthly-usage.ts': null },
        repo: {
            'src/reports/monthly-usage.ts': `import { db } from '../db';

export async function monthlyUsageCsv(from: Date, to: Date): Promise<string> {
    const rows = await db.query(
        'SELECT customer_id, event, created_at FROM usage_events WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at',
        [from, to],
    );
    const lines = rows.map((r) => [r.customer_id, r.event, r.created_at].join(','));
    return ['customer_id,event,created_at', ...lines].join('\\n');
}
`,
            'src/db.ts': DB,
        },
        expect: [{ quiet: 'src/reports/monthly-usage.ts', about: UNBOUNDED }],
    },
    {
        id: 'report-query-per-row',
        theme: 'reports',
        checks: 'Flags a query per row inside a report loop, which the whole-period memory does not cover',
        memories: [reportsNoLimit],
        prTitle: 'Add customer names to the usage export',
        prBody: 'Finance wants the customer name next to each event.',
        before: { 'src/reports/monthly-usage.ts': null },
        repo: {
            'src/reports/monthly-usage.ts': `import { db } from '../db';

export async function monthlyUsageCsv(from: Date, to: Date): Promise<string> {
    const rows = await db.query(
        'SELECT customer_id, event, created_at FROM usage_events WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at',
        [from, to],
    );
    const lines: string[] = [];
    for (const r of rows) {
        const [customer] = await db.query('SELECT name FROM customers WHERE id = $1', [r.customer_id]);
        lines.push([r.customer_id, customer?.name, r.event, r.created_at].join(','));
    }
    return ['customer_id,name,event,created_at', ...lines].join('\\n');
}
`,
            'src/db.ts': DB,
        },
        expect: [{ flag: 'src/reports/monthly-usage.ts', at: 'SELECT name FROM customers', about: N_PLUS_ONE }],
    },
    {
        id: 'config-env-read-directly',
        theme: 'config-convention',
        checks: 'Flags process.env read outside src/config, against the team convention a memory states',
        memories: [configConvention],
        prTitle: 'Send password reset emails',
        prBody: 'Adds the SMTP sender for password resets.',
        before: { 'src/mail/sender.ts': null },
        repo: {
            'src/mail/sender.ts': `import { createTransport } from 'nodemailer';

export function resetSender() {
    return createTransport({
        host: process.env.SMTP_HOST,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
}
`,
            'src/config/index.ts': CONFIG,
            'src/config/settings.ts': SETTINGS,
        },
        expect: [{ flag: 'src/mail/sender.ts', at: 'process.env.SMTP_HOST', within: 3, about: CONVENTION }],
    },
    {
        id: 'config-read-through-config',
        theme: 'config-convention',
        checks: 'Stays quiet on how settings are read when the code already uses config.get, as the convention asks',
        memories: [configConvention],
        prTitle: 'Send password reset emails',
        prBody: 'Adds the SMTP sender for password resets.',
        before: { 'src/mail/sender.ts': null },
        repo: {
            'src/mail/sender.ts': `import { createTransport } from 'nodemailer';
import { config } from '../config';

export function resetSender() {
    return createTransport({
        host: config.get('smtp.host'),
        auth: { user: config.get('smtp.user'), pass: config.get('smtp.password') },
    });
}
`,
            'src/config/index.ts': CONFIG,
            'src/config/settings.ts': SETTINGS,
        },
        expect: [{ quiet: 'src/mail/sender.ts', about: CONVENTION }],
    },
    {
        id: 'generated-edited-by-hand',
        theme: 'generated-client',
        checks: 'Flags a hand edit to src/generated with no change to openapi.yaml, which a memory says is overwritten',
        memories: [generatedClient],
        prTitle: 'Show the currency on orders',
        prBody: 'Orders now carry their currency.',
        before: { 'src/generated/api-types.ts': GENERATED_BEFORE, 'src/order-view.ts': ORDER_VIEW.replace(" ${order.currency ?? ''}", '') },
        repo: {
            'src/generated/api-types.ts': GENERATED_AFTER,
            'src/order-view.ts': ORDER_VIEW,
            'openapi.yaml': OPENAPI_BEFORE,
        },
        expect: [{ flag: 'src/generated/api-types.ts', at: 'currency?: string', about: GENERATED }],
    },
    {
        id: 'generated-from-spec',
        theme: 'generated-client',
        checks: 'Stays quiet on src/generated when the PR changes openapi.yaml and regenerates it, as the memory asks',
        memories: [generatedClient],
        prTitle: 'Show the currency on orders',
        prBody: 'Adds currency to the Order schema and regenerates the client.',
        before: {
            'openapi.yaml': OPENAPI_BEFORE,
            'src/generated/api-types.ts': GENERATED_BEFORE,
            'src/order-view.ts': ORDER_VIEW.replace(" ${order.currency ?? ''}", ''),
        },
        repo: {
            'src/generated/api-types.ts': GENERATED_AFTER,
            'src/order-view.ts': ORDER_VIEW,
            'openapi.yaml': OPENAPI_AFTER,
        },
        expect: [{ quiet: 'src/generated/api-types.ts', about: GENERATED }],
    },
];

module.exports = { CASES };
