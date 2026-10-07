import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IntentJudge } from '@libs/agents/business-validation/judge/intent-judge';
import { settleVerdict } from '@libs/agents/business-validation/judge/settle-verdict';
import type {
    RequirementState,
    ValidationResult,
} from '@libs/agents/business-validation/judge/validation.types';
import { formatTaskForJudge } from '@libs/agents/business-validation/task-quality';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';

/**
 * Does the judge get each requirement right? Runs the production judge on
 * PRs whose answer per requirement is known (the gold), and measures the
 * share of requirements it put in an accepted state, plus whether it caught
 * the change the task doesn't ask for. Plan phase 7: "the eval measures
 * accuracy per requirement against a gold standard".
 *
 * Stack-gated: hits a real model, skipped by default.
 *
 *   RUN_BR_EVAL=1 API_NODE_ENV=test npx jest --no-coverage \
 *     libs/agents/skills/business-rules-validation/evals/requirement-accuracy.live.spec.ts
 *
 * Writes the per-case report to BR_EVAL_REPORT (default: the system temp dir).
 */
const RUN = process.env.RUN_BR_EVAL === '1';
/** The share of requirements the judge must get right across all cases. */
const MIN_ACCURACY = 0.8;

type Gold = {
    /** A word or phrase that identifies the requirement in the judge's list. */
    match: string;
    /** States that count as right. */
    accept: RequirementState[];
};

type Case = {
    name: string;
    language: string;
    task: {
        id: string;
        title: string;
        description: string;
        acceptanceCriteria: string[];
    };
    diff: string;
    gold: Gold[];
    /** The diff changes something the task doesn't ask for. */
    expectsOutOfScope?: boolean;
};

const file = (name: string, lines: string[]) =>
    [
        `diff --git a/${name} b/${name}`,
        `--- a/${name}`,
        `+++ b/${name}`,
        `@@ -1,1 +1,${lines.length} @@`,
        ...lines,
    ].join('\n');

const DENSITY_TASK = {
    id: 'AB#8',
    title: 'Compact density toggle',
    description:
        'Agents with long queues want to see more tickets at once. Add a compact/comfortable density switch to the ticket list.',
    acceptanceCriteria: [
        'The density choice persists per user',
        'The default density is comfortable',
        'The toggle is visible in the ticket list toolbar',
    ],
};

const BADGE_TASK = {
    id: '#183',
    title: 'Show an "assigned to you" badge on the ticket header',
    description:
        'Agents lose track of which tickets are theirs when scanning the queue.',
    acceptanceCriteria: [
        'Show the badge only when ticket.assigneeId === currentUser.id (strict comparison)',
        'Unassigned tickets (assigneeId null) never show the badge',
        'The badge uses tone="info" so it is distinct from the status badge',
    ],
};

const badgeDiff = (condition: string[]) =>
    file('src/components/TicketHeader.tsx', [
        " import { Badge } from './Badge';",
        ' export function TicketHeader({ ticket, currentUser }: Props) {',
        ...condition,
        '   return (',
        '     <header>',
        '       <h1>{ticket.title}</h1>',
        '+      {isMine && <Badge tone="info">Assigned to you</Badge>}',
        '     </header>',
        '   );',
        ' }',
    ]);

const CASES: Case[] = [
    {
        name: 'density: one missing, one visual, one change not in the task',
        language: 'en-US',
        task: DENSITY_TASK,
        diff: [
            file('src/settings/density.ts', [
                "+export type Density = 'compact' | 'comfortable';",
                "+export const DEFAULT_DENSITY: Density = 'compact';",
                '+export async function saveDensity(userId: string, density: Density) {',
                '+  await api.patch(`/users/${userId}/preferences`, { density });',
                '+}',
            ]),
            file('src/tickets/TicketList.tsx', [
                '-const PAGE_SIZE = 25;',
                '+const PAGE_SIZE = 50;',
                '+import { DensityToggle } from "../settings/DensityToggle";',
                '+<Toolbar><DensityToggle /></Toolbar>',
            ]),
        ].join('\n'),
        gold: [
            { match: 'persist', accept: ['met'] },
            { match: 'default', accept: ['missing'] },
            { match: 'toolbar', accept: ['met', 'check_manually'] },
        ],
        expectsOutOfScope: true,
    },
    {
        name: 'badge: every criterion met',
        language: 'pt-BR',
        task: BADGE_TASK,
        diff: badgeDiff([
            '+  const isMine =',
            '+    ticket.assigneeId !== null &&',
            '+    ticket.assigneeId === currentUser.id;',
        ]),
        gold: [
            { match: 'strict', accept: ['met'] },
            { match: 'unassigned', accept: ['met'] },
            { match: 'tone', accept: ['met'] },
        ],
    },
    {
        name: 'badge: loose comparison shows the badge on unassigned tickets',
        language: 'en-US',
        task: BADGE_TASK,
        diff: badgeDiff([
            '+  const isMine = ticket.assigneeId == currentUser.id || !ticket.assigneeId;',
        ]),
        gold: [
            { match: 'strict', accept: ['missing', 'partial'] },
            { match: 'unassigned', accept: ['missing', 'partial'] },
            { match: 'tone', accept: ['met'] },
        ],
    },
];

async function judge(c: Case): Promise<ValidationResult> {
    const loader = new SkillLoaderService();
    const task = { tracker: 'Eval', ...c.task };
    const result = await new IntentJudge(
        undefined,
        { analyzerTimeoutMs: 170_000, analyzerMaxIterations: 1 },
        { organizationId: 'eval-org', teamId: 'eval-team' },
    ).judge({
        instructions: [
            loader.loadInstructions('business-rules-validation'),
            ...loader
                .listReferences('business-rules-validation')
                .map(
                    (f) =>
                        loader.loadReference('business-rules-validation', f) ??
                        '',
                ),
        ].join('\n\n---\n\n'),
        task,
        taskText: formatTaskForJudge(task),
        taskQuality: 'COMPLETE',
        diff: c.diff,
        pullRequestBody: `Closes ${c.task.id}`,
        userLanguage: c.language,
    });
    return settleVerdict(result, { unseenFiles: [] });
}

function score(c: Case, result: ValidationResult) {
    const requirements = result.requirements ?? [];
    return c.gold.map((gold) => {
        const found = requirements.find((r) =>
            r.requirement.toLowerCase().includes(gold.match.toLowerCase()),
        );
        return {
            match: gold.match,
            state: found?.state ?? 'not listed',
            right: !!found && gold.accept.includes(found.state),
        };
    });
}

(RUN ? describe : describe.skip)(
    'business-rules judge: accuracy per requirement (live)',
    () => {
        it(`gets at least ${MIN_ACCURACY * 100}% of requirements right and catches changes not in the task`, async () => {
            const report: Array<Record<string, unknown>> = [];
            let right = 0;
            let total = 0;
            let outOfScopeCaught = 0;
            let outOfScopeExpected = 0;

            for (const c of CASES) {
                const result = await judge(c);
                const scored = score(c, result);
                right += scored.filter((s) => s.right).length;
                total += scored.length;
                const flagged = (result.outOfScope ?? []).length > 0;
                if (c.expectsOutOfScope) {
                    outOfScopeExpected += 1;
                    outOfScopeCaught += flagged ? 1 : 0;
                }
                report.push({
                    case: c.name,
                    language: c.language,
                    requirements: scored,
                    outOfScope: result.outOfScope?.map((o) => o.change),
                    expectsOutOfScope: !!c.expectsOutOfScope,
                });
            }

            const accuracy = right / total;
            const out =
                process.env.BR_EVAL_REPORT ??
                path.join(
                    os.tmpdir(),
                    'business-rules-requirement-accuracy.json',
                );
            fs.writeFileSync(
                out,
                JSON.stringify(
                    {
                        accuracy,
                        right,
                        total,
                        outOfScopeCaught,
                        outOfScopeExpected,
                        report,
                    },
                    null,
                    2,
                ),
            );
            console.log(
                `[requirement-accuracy] ${right}/${total} = ${(accuracy * 100).toFixed(0)}% · out of scope caught ${outOfScopeCaught}/${outOfScopeExpected} · report ${out}`,
            );

            expect(accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
            expect(outOfScopeCaught).toBe(outOfScopeExpected);
        }, 600_000);
    },
);
