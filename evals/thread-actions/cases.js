// The cases of the thread-actions eval: a developer answers a Kody comment and
// the thread either calls for a memory or a Kody Rule — the developer states a
// team convention or a standard the team wants enforced, says an existing rule
// is too broad, or asks Kody outright — or it does not. Written for the eval
// with invented code, in English and Portuguese.
//
// Each case comes as a pair whose only difference is whether the thread calls
// for the action, so offering or writing it has to come from the thread:
//   expect.offer — Kody should propose the action and write nothing;
//   expect.act   — the developer asked: the write lands in the org's store;
//   neither      — the control: no offer, no write.
//
// A case: `kind` the action ('memory', 'rule-create', 'rule-update');
// `repo` every file at the PR's head; `kodyComment` the comment the developer
// answers (a Kody Rules finding names the rule, `rule`, which the org already
// has); `reply`; `language`; `mentions` a word the written memory or rule must
// carry, so the write is about this thread.
const SYNC_JOB = `import { fetchAccounts } from '../clients/crm';
import { saveAccounts } from '../db/accounts';

export async function syncAccounts(): Promise<void> {
    const accounts = await fetchAccounts();
    console.log(\`sync-accounts: fetched \${accounts.length} accounts\`);
    await saveAccounts(accounts);
}
`;
const JOBS_REPO = {
    'src/jobs/sync-accounts.ts': SYNC_JOB,
    'src/clients/crm.ts': `export interface Account {\n    id: string;\n    name: string;\n}\n\nexport async function fetchAccounts(): Promise<Account[]> {\n    return [];\n}\n`,
    'src/db/accounts.ts': `import { Account } from '../clients/crm';\n\nexport async function saveAccounts(accounts: Account[]): Promise<void> {}\n`,
    'src/lib/logger.ts': `export const logger = {\n    info: (message: string) => process.stdout.write(JSON.stringify({ level: 'info', message }) + '\\n'),\n};\n`,
};
const CONSOLE_COMMENT = {
    file: 'src/jobs/sync-accounts.ts',
    diffHunk: '@@ -4,2 +4,3 @@\n     const accounts = await fetchAccounts();\n+    console.log(`sync-accounts: fetched ${accounts.length} accounts`);',
    text: '`console.log` looks like a debugging leftover. Use the project logger (`src/lib/logger.ts`) so the message carries a level, or remove it.',
};

const DUE_DATE = `export function dueDate(issuedAt: Date): Date {
    const due = new Date(Date.now());
    due.setDate(issuedAt.getDate() + 30);
    return due;
}
`;
const BILLING_REPO = { 'src/billing/due-date.ts': DUE_DATE };
const CLOCK_COMMENT = {
    file: 'src/billing/due-date.ts',
    diffHunk: '@@ -1,3 +1,3 @@\n export function dueDate(issuedAt: Date): Date {\n+    const due = new Date(Date.now());',
    text: '`Date.now()` reads the system clock directly, which makes `dueDate` hard to test. Inject a clock instead.',
};

const USERS_ROUTE = `import { Router } from 'express';
import { db } from '../db';

export const usersRouter = Router();

usersRouter.post('/users', async (req, res) => {
    const user = await db.insert('users', req.body);
    res.status(201).json(user);
});
`;
const ROUTES_REPO = {
    'src/routes/users.ts': USERS_ROUTE,
    'src/db.ts': `export const db = {\n    insert: async (table: string, row: unknown) => row,\n};\n`,
};
const BODY_COMMENT = {
    file: 'src/routes/users.ts',
    diffHunk: "@@ -5,3 +5,4 @@\n usersRouter.post('/users', async (req, res) => {\n+    const user = await db.insert('users', req.body);",
    text: '`req.body` goes straight into `db.insert` without validation: any field the client sends is written to the users table.',
};

// An org's existing Kody Rule, and a finding it produced on a test helper.
const JSDOC_RULE = {
    title: 'Exported functions have a JSDoc comment',
    rule: 'Every exported function must have a JSDoc comment describing what it does and its parameters.',
    path: '**/*.ts',
    scope: 'file',
    severity: 'medium',
};
const FACTORY = `import { User } from '../../src/types';

export function makeUser(overrides: Partial<User> = {}): User {
    return { id: 'u_1', email: 'dev@example.com', ...overrides };
}
`;
const FACTORY_REPO = {
    'test/helpers/factory.ts': FACTORY,
    'src/types.ts': `export interface User {\n    id: string;\n    email: string;\n}\n`,
};
const JSDOC_COMMENT = {
    file: 'test/helpers/factory.ts',
    diffHunk: "@@ -1,5 +1,5 @@\n+export function makeUser(overrides: Partial<User> = {}): User {\n     return { id: 'u_1', email: 'dev@example.com', ...overrides };",
    text: '`makeUser` is exported without a JSDoc comment describing what it does and its parameters.',
    rule: JSDOC_RULE,
};

// The control keeps the thread and changes only the reply, to one that calls
// for nothing: the developer agrees to fix the finding, which the PR's head
// does not yet do, so the reply claims nothing the code contradicts.
const pair = (base, { id, reply, expect, mentions = null }, control) => [
    { ...base, id, reply, expect, mentions },
    { ...base, id: `${id}-control`, reply: control, expect: {}, mentions: null, checks: `Control of ${id}: neither offers nor writes when the reply calls for nothing` },
];

const CASES = [
    ...pair(
        { kind: 'memory', language: 'en-US', repo: JOBS_REPO, kodyComment: CONSOLE_COMMENT, checks: 'Offers to save as a memory a team convention the developer explains (jobs log with console.log on purpose)' },
        {
            id: 'memory-offer',
            reply: "That's intentional. Every job under src/jobs logs with console.log on purpose: the worker ships stdout straight to Datadog, and the logger would double-wrap the JSON. That's how the whole team writes jobs.",
            expect: { offer: true },
        },
        "Fair point, I'll switch it to the logger.",
    ),
    ...pair(
        { kind: 'memory', language: 'en-US', repo: JOBS_REPO, kodyComment: CONSOLE_COMMENT, checks: 'Saves the memory when the developer asks Kody to remember a convention' },
        {
            id: 'memory-act',
            reply: "@kody remember this for future reviews: jobs under src/jobs log with console.log on purpose, because the worker ships stdout to Datadog. Don't flag it again.",
            expect: { act: true },
            mentions: 'console.log',
        },
        "@kody I'll switch it to the logger. Is the rest of this job fine?",
    ),
    ...pair(
        { kind: 'memory', language: 'pt-BR', repo: BILLING_REPO, kodyComment: CLOCK_COMMENT, checks: 'Offers, in Portuguese, to save as a memory a team convention the developer explains (billing reads the clock directly)' },
        {
            id: 'pt-memory-offer',
            reply: 'Isso é convenção do time: em src/billing a gente sempre usa Date.now() direto, e os testes congelam o tempo com jest.useFakeTimers(). Ninguém injeta relógio aqui.',
            expect: { offer: true },
        },
        'Boa, vou injetar o relógio.',
    ),
    ...pair(
        { kind: 'rule-create', language: 'en-US', repo: ROUTES_REPO, kodyComment: BODY_COMMENT, checks: 'Offers to create a Kody Rule for a standard the developer says the team wants enforced' },
        {
            id: 'rule-create-offer',
            reply: "Agreed, I'll fix it. For context: every route handler in this repo validates its body with a zod schema before it touches the database. That's the team standard, this one slipped through.",
            expect: { offer: true },
        },
        "Agreed, I'll add a zod schema.",
    ),
    ...pair(
        { kind: 'rule-create', language: 'pt-BR', repo: ROUTES_REPO, kodyComment: BODY_COMMENT, checks: 'Creates the Kody Rule when the developer asks for it, in Portuguese' },
        {
            id: 'pt-rule-create-act',
            reply: '@kody cria uma Kody Rule: todo handler de rota precisa validar o body com um schema zod antes de acessar o banco.',
            expect: { act: true },
            mentions: 'zod',
        },
        '@kody vou adicionar o schema zod. O resto da rota está ok?',
    ),
    ...pair(
        { kind: 'rule-update', language: 'en-US', repo: FACTORY_REPO, kodyComment: JSDOC_COMMENT, checks: 'Offers to narrow the Kody Rule behind the finding when the developer says it is too broad' },
        {
            id: 'rule-update-offer',
            reply: "This rule shouldn't fire on test helpers: files under test/ aren't public API and nobody reads their docs.",
            expect: { offer: true },
        },
        "Good catch, I'll add the JSDoc.",
    ),
    ...pair(
        { kind: 'rule-update', language: 'en-US', repo: FACTORY_REPO, kodyComment: JSDOC_COMMENT, checks: 'Changes the Kody Rule behind the finding when the developer asks for it' },
        {
            id: 'rule-update-act',
            reply: '@kody update this rule so it no longer applies to files under test/.',
            // Narrowed by its path or by its text, it no longer covers test/.
            expect: { act: true },
        },
        "@kody I'll add the JSDoc. Is the rest of the helper fine?",
    ),
    ...pair(
        { kind: 'rule-update', language: 'pt-BR', repo: FACTORY_REPO, kodyComment: JSDOC_COMMENT, checks: 'Offers, in Portuguese, to narrow the Kody Rule behind the finding when the developer says it is too broad' },
        {
            id: 'pt-rule-update-offer',
            reply: 'Essa regra não deveria valer para os helpers de teste: nada em test/ é API pública.',
            expect: { offer: true },
        },
        'Boa, vou adicionar o JSDoc.',
    ),
];

// What the reply offers, per kind, as the judge reads it (assertsClaim). A
// control is judged on the same sentence and must not assert it.
const OFFER_CLAIM = {
    memory: 'The reply offers to save a memory for future reviews (a note Kody keeps about how this team works) — it proposes it or asks whether to — without saying it already saved one.',
    'rule-create': 'The reply offers to create a new Kody Rule that enforces this on future pull requests — it proposes it or asks whether to — without saying it already created one.',
    'rule-update': 'The reply offers to change the existing Kody Rule behind this finding, for example to narrow where it applies — it proposes it or asks whether to — without saying it already changed it.',
};

const RULE_KINDS = ['rule-create', 'rule-update'];
const kindOf = (c) => (RULE_KINDS.includes(c.kind) ? 'rule' : 'memory');

module.exports = { CASES, OFFER_CLAIM, kindOf };
