// P11 linked guides of the reviewed repository: an agent whose rules live only
// in skills and docs linked to it (codeReviewConfig.knowledge) posts the
// violation it finds, quoting the guide, and stays quiet on a near miss. The
// review runs on the local sandbox, as a self-hosted install without an E2B
// key does: its command channel refuses git, and the quote gate must still
// read the guide on the target branch.
// Invented domain: a ledger team's money and events rules.

const AGENT_ID = 'agent-ledger';

const MONEY_SKILL = `---
name: money
description: How amounts of money are computed, stored and shown. Use when code computes, stores or formats an amount.
---

# Money

- Amounts are integer cents held in a number that is always an integer.
- Never multiply an amount by a fractional rate yourself; call applyRate(amountCents, rateBps) from src/money.ts, which rounds half-even.
`;

const EVENTS_DOC = `# Events

- Every event name is lowercase, past tense, and ends in a version suffix, like invoice.paid.v1.
- A changed payload shape gets a new version; never change the payload of a published version.
`;

const REPO = {
    '.skills/money/SKILL.md': MONEY_SKILL,
    'docs/events.md': EVENTS_DOC,
    'src/money.ts': `/** rateBps: basis points (150 = 1.5%). Rounds half-even. */
export declare function applyRate(amountCents: number, rateBps: number): number;
`,
    'src/platform.ts': `export declare const events: { publish(name: string, payload: object): Promise<void> };
`,
    'src/db.ts': `export interface Invoice {
    id: string;
    totalCents: number;
}

export declare const db: { invoices: { findById(id: string): Promise<Invoice | null> } };
`,
};

const agent = {
    id: AGENT_ID,
    name: 'Ledger conventions',
    enabled: true,
    instructions: `Review the change against the team's linked guides.
Report only what a rule in one of those guides forbids, and quote the rule.`,
    scope: {},
    tools: {},
    presentation: {
        tag: { color: '#2563eb' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
};

const knowledge = [
    {
        path: '.skills/money/SKILL.md',
        kind: 'skill',
        linkedTo: [{ agentId: AGENT_ID }],
    },
    { path: 'docs/events.md', kind: 'doc', linkedTo: [{ agentId: AGENT_ID }] },
];

const MONEY = /applyRate|fraction|round|integer|cents|money|rate/i;
const EVENT = /past tense|version|v1|event name|lowercase|invoice\.paid/i;

const FEES_BEFORE = `import { Invoice } from './db';

export function amountDue(invoice: Invoice): number {
    return invoice.totalCents;
}
`;

const GUIDE_CASES = [
    {
        id: 'guide-skill-violated',
        checks: 'An agent whose rules are a linked skill flags a late fee computed with a float rate, quoting the skill',
        team: { agent, knowledge },
        prTitle: 'Late fee',
        prBody: 'Adds a 1.5% late fee.',
        before: { 'src/fees.ts': FEES_BEFORE },
        repo: {
            ...REPO,
            'src/fees.ts': `import { Invoice } from './db';

export function amountDue(invoice: Invoice, late: boolean): number {
    const fee = late ? invoice.totalCents * 0.015 : 0;
    return invoice.totalCents + fee;
}
`,
        },
        expect: [
            {
                property: 'P11',
                flag: 'src/fees.ts',
                at: 'const fee = late ? invoice.totalCents * 0.015 : 0;',
                about: MONEY,
            },
        ],
    },
    {
        id: 'guide-doc-violated-among-other-changes',
        checks: 'The same agent flags an unversioned event name from a linked doc, in a PR that mostly renames and tests',
        team: { agent, knowledge },
        prTitle: 'Rename settle to markPaid, and tests',
        prBody: 'Renames settle() to markPaid() across the module and adds tests.',
        before: {
            'src/invoices/pay.ts': `import { db } from '../db';

export async function settle(invoiceId: string): Promise<void> {
    await db.invoices.findById(invoiceId);
}
`,
            'src/invoices/pay.spec.ts': null,
        },
        repo: {
            ...REPO,
            'src/invoices/pay.ts': `import { db } from '../db';
import { events } from '../platform';

export async function markPaid(invoiceId: string): Promise<void> {
    const invoice = await db.invoices.findById(invoiceId);
    if (!invoice) return;
    await events.publish('invoicePaid', { invoiceId, totalCents: invoice.totalCents });
}
`,
            'src/invoices/pay.spec.ts': `import { markPaid } from './pay';

describe('markPaid', () => {
    it('does nothing for an unknown invoice', async () => {
        await expect(markPaid('missing')).resolves.toBeUndefined();
    });
});
`,
        },
        expect: [
            {
                property: 'P11',
                flag: 'src/invoices/pay.ts',
                at: "await events.publish('invoicePaid'",
                about: EVENT,
            },
        ],
    },
    {
        id: 'guide-near-miss',
        checks: 'The same agent stays quiet on a percentage that is not money (near miss of the skill, control)',
        team: { agent, knowledge },
        prTitle: 'Collection progress',
        prBody: 'Shows how many invoices of a batch are paid.',
        before: { 'src/progress.ts': null },
        repo: {
            ...REPO,
            'src/progress.ts': `export function paidShare(paidCount: number, total: number): string {
    if (total === 0) return '0%';
    return \`\${Math.round((paidCount / total) * 100)}%\`;
}
`,
        },
        expect: [{ property: 'P11', quiet: 'src/progress.ts', about: MONEY }],
    },
];

module.exports = { GUIDE_CASES };
