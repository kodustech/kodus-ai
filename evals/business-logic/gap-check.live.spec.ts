import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createGapCheck,
    type RepositoryReader,
} from '@libs/agents/business-validation/judge/gap-check';
import { aiSdkAgentRun } from '@libs/agents/business-validation/trackers/task-finder';

/**
 * Does the second look at a MISSING requirement overturn only real false
 * gaps? Each case is a requirement the judge called MISSING from the diff,
 * and a small repository at the PR head. Some already do it outside the diff
 * (it must become MET or PARTIAL, citing the line); some don't, or only look
 * like they do (it must stay MISSING). The domain is invented.
 *
 * Stack-gated: hits a real model, skipped by default.
 *
 *   RUN_BR_EVAL=1 API_NODE_ENV=test npx jest --no-coverage \
 *     evals/business-logic/gap-check.live.spec.ts
 */
const RUN = process.env.RUN_BR_EVAL === '1';

type Case = {
    name: string;
    requirement: string;
    diff: string;
    files: Record<string, string>;
    /** What a right answer is. */
    expect: Array<'met' | 'partial' | 'missing'>;
    /** For a refutation: the file it must cite. */
    cites?: string;
};

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
    'business-rules gap check: refutes only false gaps (live)',
    () => {
        it('overturns a MISSING only where the code already does it', async () => {
            const check = createGapCheck(
                aiSdkAgentRun(undefined, { organizationId: 'eval-org' }),
            );
            const report: Array<Record<string, unknown>> = [];
            let right = 0;
            for (const c of CASES) {
                const result = await check({
                    requirement: {
                        requirement: c.requirement,
                        state: 'missing',
                        evidence: [],
                        confidence: 'high',
                        note: 'No evidence in this PR diff.',
                    },
                    taskText: c.requirement,
                    diff: c.diff,
                    reader: readerOf(c.files),
                });
                const state = result?.state ?? 'missing';
                const ok =
                    c.expect.includes(state) &&
                    (!result ||
                        !c.cites ||
                        result.evidence[0]?.file === c.cites);
                right += ok ? 1 : 0;
                report.push({ case: c.name, state, result, ok });
            }
            const out =
                path.join(
                    process.env.BR_EVAL_REPORT_DIR ?? os.tmpdir(),
                    'business-rules-gap-check.json',
                );
            fs.writeFileSync(
                out,
                JSON.stringify({ right, total: CASES.length, report }, null, 2),
            );
            console.log(`[gap-check] ${right}/${CASES.length} · report ${out}`);
            expect(right).toBe(CASES.length);
        }, 600_000);
    },
);
