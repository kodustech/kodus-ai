/**
 * Does the verdict hold wherever the task keeps its criteria? One task and one
 * diff with a known answer per requirement, read through each tracker the way
 * production reads it (server payload → tracker → criteria location → judge),
 * with the criteria under a heading, in a Jira custom field, in Azure's HTML
 * field, in a Notion property, or in Portuguese. Every variant must get the
 * same requirements right.
 *
 * Stack-gated: hits a real model, skipped by default.
 *
 *   RUN_BR_EVAL=1 API_NODE_ENV=test npx jest --no-coverage \
 *     test/evals/business-rules-validation/criteria-location
 *
 * Writes the per-variant report into BR_EVAL_REPORT_DIR (default: the system temp dir).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Task } from '@libs/agents/business-validation/business-validation.types';
import { IntentJudge } from '@libs/agents/business-validation/judge/intent-judge';
import { settleVerdict } from '@libs/agents/business-validation/judge/settle-verdict';
import type {
    RequirementState,
    ValidationResult,
} from '@libs/agents/business-validation/judge/validation.types';
import {
    type BusinessLogicSettings,
    DEFAULT_BUSINESS_LOGIC_SETTINGS,
} from '@libs/agents/business-validation/settings';
import {
    applyCriteriaLocation,
    formatTaskForJudge,
    gradeTask,
} from '@libs/agents/business-validation/task-quality';
import { extractTaskReferences } from '@libs/agents/business-validation/task-references';
import { CustomMcpTracker } from '@libs/agents/business-validation/trackers/custom-mcp.tracker';
import { GitIssuesTracker } from '@libs/agents/business-validation/trackers/git-issues.tracker';
import { JiraTracker } from '@libs/agents/business-validation/trackers/jira.tracker';
import { LinearTracker } from '@libs/agents/business-validation/trackers/linear.tracker';
import { NotionTracker } from '@libs/agents/business-validation/trackers/notion.tracker';
import type { TaskTracker } from '@libs/agents/business-validation/trackers/tracker';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';

import type {
    TrackerFixture,
    TrackerTask,
} from '../task-resolution/fixture.types';
import { renderTask } from '../task-resolution/servers';

const RUN = process.env.RUN_BR_EVAL === '1';
/** Every requirement right in every variant: where the criteria live must not change the verdict. */
const MIN_ACCURACY = 1;

const CRITERIA = [
    'The density choice persists per user',
    'The default density is comfortable',
    'The toggle is visible in the ticket list toolbar',
];
const CRITERIA_PT = [
    'A escolha de densidade persiste por usuário',
    'A densidade padrão é confortável',
    'O seletor aparece na barra de ferramentas da lista de tickets',
];
const DESCRIPTION =
    'Agents with long queues want to see more tickets at once. Add a compact/comfortable density switch to the ticket list.';

type Gold = { match: string; accept: RequirementState[] };
// The diff saves the choice but never reads it back, so "persists" is MET or
// PARTIAL depending on the run, never on where the criterion lives.
const GOLD: Gold[] = [
    { match: 'persist', accept: ['met', 'partial'] },
    { match: 'default', accept: ['missing'] },
    { match: 'toolbar', accept: ['met', 'check_manually'] },
];
const GOLD_PT: Gold[] = [
    { match: 'persist', accept: ['met', 'partial'] },
    { match: 'padrão', accept: ['missing'] },
    { match: 'barra', accept: ['met', 'check_manually'] },
];

const file = (name: string, lines: string[]) =>
    [
        `diff --git a/${name} b/${name}`,
        `--- a/${name}`,
        `+++ b/${name}`,
        `@@ -1,1 +1,${lines.length} @@`,
        ...lines,
    ].join('\n');

/** Persists per user, defaults to compact (wrong), adds the toggle to the toolbar. */
const DIFF = [
    file('src/settings/density.ts', [
        "+export type Density = 'compact' | 'comfortable';",
        "+export const DEFAULT_DENSITY: Density = 'compact';",
        '+export async function saveDensity(userId: string, density: Density) {',
        '+  await api.patch(`/users/${userId}/preferences`, { density });',
        '+}',
    ]),
    file('src/tickets/TicketList.tsx', [
        '+import { DensityToggle } from "../settings/DensityToggle";',
        '+<Toolbar><DensityToggle /></Toolbar>',
    ]),
].join('\n');

/** A session that answers like the real server, from servers.ts. */
function session(
    shape: TrackerFixture['responseShape'],
    task: TrackerTask,
    tools: Array<{ name: string; properties?: Record<string, unknown> }>,
) {
    const tracker = { responseShape: shape } as TrackerFixture;
    return {
        called: [] as string[],
        tools: async () =>
            tools.map((t) => ({
                name: t.name,
                description: t.name,
                inputSchema: { type: 'object', properties: t.properties ?? {} },
            })),
        call: async (name: string, args: Record<string, unknown>) => {
            if (name === 'getAccessibleAtlassianResources') {
                return [
                    {
                        id: 'cloud-1',
                        url: 'https://acme.atlassian.net',
                        scopes: [],
                    },
                ];
            }
            if (name === 'KODUS_GET_ISSUE') {
                return {
                    success: true,
                    data: {
                        number: Number(task.id),
                        title: task.title,
                        body: task.description,
                        url: `https://github.com/acme/desk/issues/${task.id}`,
                    },
                };
            }
            return renderTask(tracker, task, args);
        },
        close: async () => undefined,
    } as never;
}

type Variant = {
    name: string;
    language: string;
    reference: string;
    tracker: (task: TrackerTask) => TaskTracker;
    task: TrackerTask;
    criteria?: BusinessLogicSettings['criteria'];
    gold?: Gold[];
};

const base = { title: 'Compact density toggle', description: DESCRIPTION };
const jiraField = { id: 'customfield_10031', name: 'Acceptance Criteria' };
const rovo = (task: TrackerTask) =>
    new JiraTracker(
        session('jira', task, [
            { name: 'getJiraIssue', properties: { fields: {}, expand: {} } },
        ]),
    );

const VARIANTS: Variant[] = [
    {
        name: 'Linear, under "Acceptance criteria"',
        language: 'en-US',
        reference: 'SAA-8',
        tracker: (t) => new LinearTracker(session('linear', t, [])),
        task: { id: 'SAA-8', ...base, acceptanceCriteria: CRITERIA },
    },
    {
        name: 'Linear, under the team heading "Definition of done"',
        language: 'en-US',
        reference: 'SAA-8',
        tracker: (t) => new LinearTracker(session('linear', t, [])),
        task: {
            id: 'SAA-8',
            ...base,
            acceptanceCriteria: CRITERIA,
            criteriaAt: 'heading',
            criteriaHeading: 'Definition of done',
        },
        criteria: { location: 'heading', heading: 'Definition of done' },
    },
    {
        name: 'Jira, in a custom field the team named',
        language: 'en-US',
        reference: 'DESK-8',
        tracker: rovo,
        task: {
            id: 'DESK-8',
            ...base,
            acceptanceCriteria: CRITERIA,
            criteriaAt: 'field',
            field: jiraField,
            fieldFormat: 'adf',
        },
        criteria: { location: 'field', field: 'Acceptance Criteria' },
    },
    {
        name: 'Jira, in a custom field nobody named (auto)',
        language: 'en-US',
        reference: 'DESK-8',
        tracker: rovo,
        task: {
            id: 'DESK-8',
            ...base,
            acceptanceCriteria: CRITERIA,
            criteriaAt: 'field',
            field: jiraField,
        },
    },
    {
        name: 'Azure DevOps, in the AcceptanceCriteria HTML field',
        language: 'en-US',
        reference: 'AB#8',
        tracker: (t) =>
            new CustomMcpTracker(
                'Azure DevOps',
                session('azure', t, [
                    {
                        name: 'wit_get_work_item',
                        properties: { id: { type: 'number' } },
                    },
                ]),
                'wit_get_work_item',
            ),
        task: {
            id: '8',
            ...base,
            acceptanceCriteria: CRITERIA,
            criteriaAt: 'field',
            field: {
                id: 'Microsoft.VSTS.Common.AcceptanceCriteria',
                name: 'Acceptance Criteria',
            },
        },
    },
    {
        name: 'Notion, in a page property',
        language: 'en-US',
        reference:
            'https://www.notion.so/acme/Compact-density-1a2b3c4d5e6f40718293a4b5c6d7e8f9',
        tracker: (t) =>
            new NotionTracker(session('notion', t, [{ name: 'notion-fetch' }])),
        task: {
            id: '1a2b3c4d5e6f40718293a4b5c6d7e8f9',
            ...base,
            acceptanceCriteria: CRITERIA,
            criteriaAt: 'properties',
            field: { id: 'Acceptance criteria', name: 'Acceptance criteria' },
        },
        criteria: { location: 'field', field: 'Acceptance criteria' },
    },
    {
        name: 'GitHub issue in Portuguese, a checklist under "Critérios de aceite"',
        language: 'pt-BR',
        reference: '#8',
        tracker: (t) => new GitIssuesTracker(session('linear', t, [])),
        task: {
            id: '8',
            title: 'Alternar densidade compacta',
            description: `Quem tem filas longas quer ver mais tickets de uma vez.\n\n## Critérios de aceite\n${CRITERIA_PT.map((c) => `- [ ] ${c}`).join('\n')}`,
        },
        gold: GOLD_PT,
    },
];

async function judgeOnce(
    instructions: string,
    task: Task,
    variant: Variant,
): Promise<ValidationResult> {
    return settleVerdict(
        await new IntentJudge(
            undefined,
            { analyzerTimeoutMs: 170_000, analyzerMaxIterations: 1 },
            { organizationId: 'eval-org', teamId: 'eval-team' },
        ).judge({
            instructions,
            task,
            taskText: formatTaskForJudge(task),
            taskQuality: gradeTask(task),
            diff: DIFF,
            pullRequestBody: `Closes ${variant.reference}`,
            userLanguage: variant.language,
        }),
        { unseenFiles: [] },
    );
}

async function readTask(variant: Variant): Promise<Task> {
    const [reference] = extractTaskReferences({ command: variant.reference });
    const lookup = await variant.tracker(variant.task).read(reference, {
        organizationAndTeamData: {
            organizationId: 'eval-org',
            teamId: 'eval-team',
        },
        repository: { owner: 'acme', name: 'desk' },
    });
    if (lookup.status !== 'found') {
        throw new Error(
            `${variant.name}: the tracker answered ${lookup.status}`,
        );
    }
    return applyCriteriaLocation(
        lookup.task,
        variant.criteria ?? DEFAULT_BUSINESS_LOGIC_SETTINGS.criteria,
    );
}

describe('every variant hands the judge its criteria', () => {
    for (const variant of VARIANTS) {
        it(variant.name, async () => {
            const task = await readTask(variant);
            const expected = variant.gold === GOLD_PT ? CRITERIA_PT : CRITERIA;
            expect(task.acceptanceCriteria).toEqual(expected);
        });
    }
});

(RUN ? describe : describe.skip)(
    'business-rules judge: the verdict holds wherever the criteria live (live)',
    () => {
        it(`gets at least ${Math.round(MIN_ACCURACY * 100)}% right in every variant`, async () => {
            const loader = new SkillLoaderService();
            const instructions = [
                loader.loadInstructions('business-rules-validation'),
                ...loader
                    .listReferences('business-rules-validation')
                    .map(
                        (f) =>
                            loader.loadReference(
                                'business-rules-validation',
                                f,
                            ) ?? '',
                    ),
            ].join('\n\n---\n\n');

            const report: Array<Record<string, unknown>> = [];
            for (const variant of VARIANTS) {
                const task = await readTask(variant);
                // A judge that answered nothing (timeout, rate limit) is an
                // infrastructure failure, not a wrong verdict: asked once more.
                const failures: string[] = [];
                let result = await judgeOnce(instructions, task, variant);
                if (!result.requirements?.length) {
                    failures.push(String(result.reason ?? 'no requirements'));
                    result = await judgeOnce(instructions, task, variant);
                }
                const requirements = result.requirements ?? [];
                const scored = (variant.gold ?? GOLD).map((gold) => {
                    const found = requirements.find((r) =>
                        r.requirement
                            .toLowerCase()
                            .includes(gold.match.toLowerCase()),
                    );
                    return {
                        match: gold.match,
                        state: found?.state ?? 'not listed',
                        right: !!found && gold.accept.includes(found.state),
                    };
                });
                report.push({
                    variant: variant.name,
                    criteriaGiven: task.acceptanceCriteria ?? [],
                    quality: gradeTask(task),
                    accuracy:
                        scored.filter((s) => s.right).length / scored.length,
                    requirements: scored,
                    judgeFailures: failures,
                });
            }

            const out =
                path.join(
                    process.env.BR_EVAL_REPORT_DIR ?? os.tmpdir(),
                    'business-rules-criteria-location.json',
                );
            fs.writeFileSync(out, JSON.stringify(report, null, 2));
            for (const r of report) {
                console.log(
                    `[criteria-location] ${(Number(r.accuracy) * 100).toFixed(0)}% · ${r.variant}`,
                );
            }

            for (const r of report) {
                expect({
                    variant: r.variant,
                    ok: Number(r.accuracy) >= MIN_ACCURACY,
                }).toEqual({
                    variant: r.variant,
                    ok: true,
                });
            }
        }, 900_000);
    },
);
