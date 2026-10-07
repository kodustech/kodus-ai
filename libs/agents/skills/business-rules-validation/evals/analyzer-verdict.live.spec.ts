import { IntentJudge } from '@libs/agents/business-validation/judge/intent-judge';
import type { ValidationResult } from '@libs/agents/business-validation/judge/validation.types';
import { resolveValidationStatus } from '@libs/agents/business-validation/judge/validation-verdict';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';

/**
 * #2019 — does a real model fill the verdict? Runs the production analyzer
 * (SKILL.md + references, the production prompt builder, `callLLM` with the
 * `submitValidation` result tool) on a compliant PR and on a PR with a gap, in
 * English and Portuguese, and checks the verdict each one carries.
 *
 * Stack-gated: hits a real model, skipped by default.
 *
 *   RUN_BR_EVAL=1 API_NODE_ENV=test npx jest --no-coverage \
 *     libs/agents/skills/business-rules-validation/evals/analyzer-verdict.live.spec.ts
 */
const RUN = process.env.RUN_BR_EVAL === '1';

const TASK = [
    'Task ID: #183',
    'Title: Show an "assigned to you" badge on the ticket header',
    'Description:',
    'Agents lose track of which tickets are theirs when scanning the queue.',
    'Acceptance Criteria:',
    '- Show the badge only when ticket.assigneeId === currentUser.id (strict comparison).',
    '- The badge is visually distinct from the status badge (use tone="info").',
    '- Unassigned tickets (assigneeId null) never show the badge.',
].join('\n');

const header = (body: string) =>
    [
        'diff --git a/src/components/TicketHeader.tsx b/src/components/TicketHeader.tsx',
        '--- a/src/components/TicketHeader.tsx',
        '+++ b/src/components/TicketHeader.tsx',
        '@@ -1,12 +1,22 @@',
        " import { Badge } from './Badge';",
        '',
        ' export function TicketHeader({ ticket, currentUser }: Props) {',
        body,
        '   return (',
        '     <header>',
        '       <h1>{ticket.title}</h1>',
        '+      {isMine && <Badge tone="info">Assigned to you</Badge>}',
        '     </header>',
        '   );',
        ' }',
    ].join('\n');

const COMPLIANT_DIFF = header(
    [
        '+  const isMine =',
        '+    ticket.assigneeId !== null &&',
        '+    ticket.assigneeId === currentUser.id;',
    ].join('\n'),
);

// Loose comparison and no null guard: AC #1 and AC #3 are not met.
const GAP_DIFF = header('+  const isMine = ticket.assigneeId == currentUser.id || !ticket.assigneeId;');

async function analyze(
    diff: string,
    userLanguage: string,
): Promise<ValidationResult> {
    const loader = new SkillLoaderService();
    const result = await new IntentJudge(
        undefined,
        { analyzerTimeoutMs: 170_000, analyzerMaxIterations: 1 },
        { organizationId: 'eval-org', teamId: 'eval-team' },
    ).judge({
        instructions: [
            loader.loadInstructions('business-rules-validation'),
            ...loader
                .listReferences('business-rules-validation')
                .map((file) => loader.loadReference('business-rules-validation', file) ?? ''),
        ].join('\n\n---\n\n'),
        task: { tracker: 'Git Issues', id: '#183', title: 'Mine badge' },
        taskText: TASK,
        taskQuality: 'COMPLETE',
        diff,
        pullRequestBody: 'Closes #183',
        userLanguage,
    });
    console.log(
        `[analyzer-verdict] lang=${userLanguage} status=${result.status} reason=${result.reason} findings=${JSON.stringify(result.findings)} missing=${(result.missingInfo ?? "").slice(0, 160)}`,
    );
    return result;
}

(RUN ? describe : describe.skip)('business-rules analyzer verdict (live, #2019)', () => {
    it.each(['en-US', 'pt-BR'])(
        'marks a PR that implements every criterion as compliant (%s)',
        async (language) => {
            const result = await analyze(COMPLIANT_DIFF, language);
            expect(resolveValidationStatus(result)).toBe('compliant');
        },
        180_000,
    );

    it.each(['en-US', 'pt-BR'])(
        'marks a PR that misses criteria as issues_found (%s)',
        async (language) => {
            const result = await analyze(GAP_DIFF, language);
            expect(resolveValidationStatus(result)).toBe('issues_found');
        },
        180_000,
    );
});
