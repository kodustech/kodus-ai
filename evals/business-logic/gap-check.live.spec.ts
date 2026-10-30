import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createGapCheck,
    type RepositoryReader,
} from '@libs/agents/business-validation/judge/gap-check';
import { aiSdkAgentRun } from '@libs/agents/business-validation/trackers/task-finder';

import { evalModel } from './eval-model';

/**
 * Does the second look settle only what the repository settles? Each case is
 * a requirement the judge left open from the diff (MISSING, PARTIAL or CHECK
 * MANUALLY) and a small repository at the PR head. Some are done outside the
 * diff (they must become MET, citing the line); some are not, or only look
 * like they are (a MISSING stays MISSING, a PARTIAL stays PARTIAL, a CHECK
 * MANUALLY whose helper lacks the rule becomes MISSING, citing the helper).
 * The domain is invented.
 *
 * Stack-gated: hits a real model, skipped by default.
 *
 *   RUN_BR_EVAL=1 API_NODE_ENV=test npx jest --no-coverage \
 *     evals/business-logic/gap-check.live.spec.ts
 */
const RUN = process.env.RUN_BR_EVAL === '1';

type State = 'met' | 'partial' | 'missing' | 'check_manually';

type Case = {
    name: string;
    requirement: string;
    /** What the judge said from the diff; MISSING when unset. */
    from?: Exclude<State, 'met'>;
    /** Why the judge said it. */
    note?: string;
    diff: string;
    files: Record<string, string>;
    /** What a right answer is. */
    expect: State[];
    /** For a changed state: the file it must cite. */
    cites?: string;
};

const RENEW_DIFF = [
    '=== FILE: src/loans/renew.ts ===',
    '@@ -0,0 +1,9 @@',
    "+import { assertRenewable } from './rules';",
    "+import { loans } from './store';",
    '+',
    '+export async function renewLoan(loanId: string, memberId: string) {',
    '+  const loan = await loans.get(loanId);',
    '+  assertRenewable(loan, memberId);',
    '+  loan.dueDate = new Date(loan.dueDate.getTime() + 14 * 86_400_000);',
    '+  await loans.save(loan);',
    '+}',
].join('\n');

const RENEW_FILE =
    "import { assertRenewable } from './rules';\nimport { loans } from './store';\n\nexport async function renewLoan(loanId: string, memberId: string) {\n  const loan = await loans.get(loanId);\n  assertRenewable(loan, memberId);\n  loan.dueDate = new Date(loan.dueDate.getTime() + 14 * 86_400_000);\n  await loans.save(loan);\n}\n";

// The helper the renewal calls, untouched by the PR: it refuses overdue
// loans and says nothing about reservations.
const RULES_FILE = [
    "import { LoanError } from './errors';",
    '',
    'export function assertRenewable(loan: { dueDate: Date }, memberId: string) {',
    '  if (loan.dueDate.getTime() < Date.now()) {',
    "    throw new LoanError('This loan is overdue and cannot be renewed.');",
    '  }',
    '}',
].join('\n');

const DETAIL_DIFF = [
    '=== FILE: src/api/appointments/detail.route.ts ===',
    '@@ -0,0 +1,7 @@',
    "+import { appointments } from '../../appointments/store';",
    "+import { toAppointmentDto } from './appointment.dto';",
    '+',
    '+export async function getAppointment(req: { params: { id: string } }) {',
    "+  const appointment = await appointments.find(req.params.id, { with: ['doctor', 'clinic'] });",
    '+  return toAppointmentDto(appointment);',
    '+}',
].join('\n');

const DETAIL_FILE =
    "import { appointments } from '../../appointments/store';\nimport { toAppointmentDto } from './appointment.dto';\n\nexport async function getAppointment(req: { params: { id: string } }) {\n  const appointment = await appointments.find(req.params.id, { with: ['doctor', 'clinic'] });\n  return toAppointmentDto(appointment);\n}\n";

const dto = (withAddress: boolean) =>
    [
        'export function toAppointmentDto(a: any) {',
        '  return {',
        '    id: a.id,',
        '    startsAt: a.startsAt.toISOString(),',
        '    doctorName: a.doctor.name,',
        ...(withAddress ? ['    clinicAddress: a.clinic.address,'] : []),
        '  };',
        '}',
    ].join('\n');

const TOOLBAR_DIFF = [
    '=== FILE: src/tickets/Toolbar.tsx ===',
    '@@ -1,6 +1,8 @@',
    " import { PriorityFilter } from './PriorityFilter';",
    ' export function Toolbar() {',
    '   return (',
    '     <div>',
    '+      <PriorityFilter />',
    '     </div>',
    '   );',
    ' }',
].join('\n');

const CASES: Case[] = [
    {
        name: 'a default the PR reuses, set in a file it did not touch',
        requirement: 'The priority filter defaults to All.',
        diff: TOOLBAR_DIFF,
        files: {
            'src/tickets/Toolbar.tsx':
                "import { PriorityFilter } from './PriorityFilter';\nexport function Toolbar() {\n  return (\n    <div>\n      <PriorityFilter />\n    </div>\n  );\n}\n",
            'src/tickets/PriorityFilter.tsx': [
                "import { useState } from 'react';",
                "import { PRIORITIES } from './priorities';",
                '',
                'export function PriorityFilter() {',
                "  const [value, setValue] = useState<string>('all');",
                '  return (',
                '    <select value={value} onChange={(e) => setValue(e.target.value)}>',
                '      <option value="all">All</option>',
                '      {PRIORITIES.map((p) => <option key={p}>{p}</option>)}',
                '    </select>',
                '  );',
                '}',
            ].join('\n'),
            'src/tickets/priorities.ts':
                "export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];\n",
        },
        expect: ['met'],
        cites: 'src/tickets/PriorityFilter.tsx',
    },
    {
        name: 'a real gap: nothing asks for confirmation',
        requirement:
            'Archiving more than 50 tickets asks for confirmation first.',
        diff: [
            '=== FILE: src/tickets/bulkArchive.ts ===',
            '@@ -0,0 +1,5 @@',
            "+import { api } from '../api';",
            '+export async function archiveSelected(ids: string[]) {',
            "+  await api.post('/tickets/archive', { ids });",
            '+}',
        ].join('\n'),
        files: {
            'src/tickets/bulkArchive.ts':
                "import { api } from '../api';\nexport async function archiveSelected(ids: string[]) {\n  await api.post('/tickets/archive', { ids });\n}\n",
            'src/api.ts':
                "export const api = { post: async (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) }) };\n",
        },
        expect: ['missing'],
    },
    {
        name: 'a look-alike: confirmation exists, but for deleting, not archiving',
        requirement:
            'Archiving more than 50 tickets asks for confirmation first.',
        diff: [
            '=== FILE: src/tickets/bulkArchive.ts ===',
            '@@ -0,0 +1,5 @@',
            "+import { api } from '../api';",
            '+export async function archiveSelected(ids: string[]) {',
            "+  await api.post('/tickets/archive', { ids });",
            '+}',
        ].join('\n'),
        files: {
            'src/tickets/bulkArchive.ts':
                "import { api } from '../api';\nexport async function archiveSelected(ids: string[]) {\n  await api.post('/tickets/archive', { ids });\n}\n",
            'src/tickets/bulkDelete.ts': [
                "import { api } from '../api';",
                "import { confirm } from '../ui/confirm';",
                '',
                'export async function deleteSelected(ids: string[]) {',
                '  if (ids.length > 50 && !(await confirm(`Delete ${ids.length} tickets?`))) {',
                '    return;',
                '  }',
                "  await api.post('/tickets/delete', { ids });",
                '}',
            ].join('\n'),
            'src/ui/confirm.ts':
                'export const confirm = async (message: string) => window.confirm(message);\n',
        },
        expect: ['missing'],
    },
    {
        name: 'half there: the limit is checked, but no message says why',
        requirement:
            'A comment longer than 2000 characters is rejected with a message saying the limit.',
        diff: [
            '=== FILE: src/comments/CommentBox.tsx ===',
            '@@ -1,3 +1,4 @@',
            " import { postComment } from './postComment';",
            '+// submit wired to postComment',
        ].join('\n'),
        files: {
            'src/comments/CommentBox.tsx':
                "import { postComment } from './postComment';\n// submit wired to postComment\nexport function CommentBox() { return null; }\n",
            'src/comments/postComment.ts': [
                'const MAX = 2000;',
                '',
                'export function postComment(text: string) {',
                '  if (text.length > MAX) {',
                "    throw new Error('invalid');",
                '  }',
                "  return fetch('/comments', { method: 'POST', body: text });",
                '}',
            ].join('\n'),
        },
        expect: ['partial', 'missing'],
    },
    {
        name: 'check manually: the helper the PR calls already refuses it',
        requirement: 'Renewing a loan that is already overdue is refused.',
        from: 'check_manually',
        note: 'The renewal calls assertRenewable, whose code is not in this diff.',
        diff: RENEW_DIFF,
        files: {
            'src/loans/renew.ts': RENEW_FILE,
            'src/loans/rules.ts': RULES_FILE,
        },
        expect: ['met'],
        cites: 'src/loans/rules.ts',
    },
    {
        name: 'check manually: the helper the PR calls lacks the rule',
        requirement: 'A loan another member has reserved cannot be renewed.',
        from: 'check_manually',
        note: 'The renewal calls assertRenewable, whose code is not in this diff.',
        diff: RENEW_DIFF,
        files: {
            'src/loans/renew.ts': RENEW_FILE,
            'src/loans/rules.ts': RULES_FILE,
        },
        expect: ['missing'],
        cites: 'src/loans/rules.ts',
    },
    {
        name: 'check manually: nothing in the repository could do it, never MET',
        requirement:
            'The invoice PDF shows the currency code next to the total.',
        from: 'check_manually',
        note: 'No PDF code is in this diff.',
        diff: [
            '=== FILE: migrations/1730000000000-invoice-currency.ts ===',
            '@@ -0,0 +1,3 @@',
            '+export const up = (db: any) =>',
            "+  db.query('ALTER TABLE invoices ADD COLUMN currency char(3)');",
        ].join('\n'),
        files: {
            'migrations/1730000000000-invoice-currency.ts':
                "export const up = (db: any) =>\n  db.query('ALTER TABLE invoices ADD COLUMN currency char(3)');\n",
            'src/invoices/invoice.entity.ts':
                'export class Invoice {\n  id!: string;\n  total!: number;\n  currency?: string;\n}\n',
        },
        expect: ['check_manually', 'missing'],
    },
    {
        name: 'partial: the mapper the route uses already returns the address',
        requirement: 'GET /appointments/:id returns the clinic address.',
        from: 'partial',
        note: 'The route loads the clinic, but the diff does not show whether toAppointmentDto returns its address.',
        diff: DETAIL_DIFF,
        files: {
            'src/api/appointments/detail.route.ts': DETAIL_FILE,
            'src/api/appointments/appointment.dto.ts': dto(true),
        },
        expect: ['met'],
        cites: 'src/api/appointments/appointment.dto.ts',
    },
    {
        name: 'partial: the mapper the route uses drops the address',
        requirement: 'GET /appointments/:id returns the clinic address.',
        from: 'partial',
        note: 'The route loads the clinic, but the diff does not show whether toAppointmentDto returns its address.',
        diff: DETAIL_DIFF,
        files: {
            'src/api/appointments/detail.route.ts': DETAIL_FILE,
            'src/api/appointments/appointment.dto.ts': dto(false),
        },
        expect: ['partial'],
    },
];

function readerOf(files: Record<string, string>): RepositoryReader {
    return {
        listFiles: async (filter) =>
            Object.keys(files).filter((p) =>
                p.toLowerCase().includes(filter.trim().toLowerCase()),
            ),
        readFile: async (p) => files[p],
    };
}

(RUN ? describe : describe.skip)(
    'business-rules gap check: settles only what the repository settles (live)',
    () => {
        it('changes a state only where the repository settles it', async () => {
            const check = createGapCheck(
                aiSdkAgentRun(evalModel(), { organizationId: 'eval-org' }),
            );
            const report: Array<Record<string, unknown>> = [];
            let right = 0;
            for (const c of CASES) {
                const result = await check({
                    requirement: {
                        requirement: c.requirement,
                        state: c.from ?? 'missing',
                        evidence: [],
                        confidence: 'high',
                        note: c.note ?? 'No evidence in this PR diff.',
                    },
                    taskText: c.requirement,
                    diff: c.diff,
                    reader: readerOf(c.files),
                });
                const state: State = result?.state ?? c.from ?? 'missing';
                const ok =
                    c.expect.includes(state) &&
                    (!result ||
                        !c.cites ||
                        result.evidence[0]?.file === c.cites);
                right += ok ? 1 : 0;
                report.push({ case: c.name, state, result, ok });
            }
            const out = path.join(
                process.env.BR_EVAL_REPORT_DIR ?? os.tmpdir(),
                'business-rules-gap-check.json',
            );
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(
                out,
                JSON.stringify({ right, total: CASES.length, report }, null, 2),
            );
            console.log(`[gap-check] ${right}/${CASES.length} · report ${out}`);
            expect(right).toBe(CASES.length);
        }, 600_000);
    },
);
