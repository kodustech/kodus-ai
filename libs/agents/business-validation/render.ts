import type {
    BusinessValidationOutcome,
    TaskCheck,
} from './business-validation.types';
import { countBlockers } from './check-policy';
import type { FailOnState } from './settings';
import type {
    CodeLocation,
    OutOfScopeChange,
    RequirementVerdict,
} from './judge/validation.types';

/**
 * Invisible in the rendered comment, and how the comment is found again so a
 * re-check edits it instead of posting another (UC-34, UC-35).
 */
export const BUSINESS_LOGIC_COMMENT_MARKER = '<!-- kody-business-logic -->';

export const RERUN_COMMAND = '@kody -v business-logic';

const STATE_LABEL: Record<RequirementVerdict['state'], string> = {
    met: '✅ **MET**',
    partial: '🟡 **PARTIAL**',
    missing: '❌ **MISSING**',
    check_manually: '👀 **CHECK MANUALLY**',
};

const DOWNGRADE_NOTE: Record<
    NonNullable<RequirementVerdict['downgraded']>,
    string
> = {
    visual: 'Visual or flow requirement; check it in the preview.',
    low_confidence: 'Kody is not sure from the code alone; check it yourself.',
    not_in_diff:
        'Not found in the files Kody read; part of this PR was too large to read.',
};

export interface RenderContext {
    /** The commit a re-check ran on, shown so the reader knows what was read. */
    headSha?: string;
    /** Why this run happened, when it wasn't the first review. */
    trigger?: 'command' | 'push' | 'force' | 'accepted' | 'recheck';
    /** Earlier commits this PR was checked at, oldest first. */
    history?: CheckedCommit[];
    /** The team's "fails on" choice: only that reads as "to merge". */
    failOn?: readonly FailOnState[];
}

/** One earlier commit and how it stood, for the comment's trail. */
export interface CheckedCommit {
    headSha: string;
    met: number;
    total: number;
    passed?: boolean;
}

/** How many earlier commits the comment lists; the Cockpit keeps the rest. */
const MAX_HISTORY = 5;

/** The PR comment for a judged outcome, in English; the caller translates. */
export function renderComment(
    outcome: Extract<BusinessValidationOutcome, { kind: 'validated' }>,
    context: RenderContext = {},
): string {
    const sections = outcome.checks.map((check) =>
        renderTaskSection(check, context),
    );
    for (const task of outcome.thinTasks) {
        sections.push(
            `**${taskTitle(task.id, task.title, task.url)}** has too little in it to check against. Add acceptance criteria and comment \`${RERUN_COMMAND}\`.`,
        );
    }
    return [
        '## Kody · Business Logic',
        '',
        sections.join('\n\n---\n\n'),
        '',
        ...historyLine(context.history),
        `<sub>Disagree with a line? Reply here and mention @kody. Fixed it? Comment \`${RERUN_COMMAND}\` and this comment is updated.</sub>`,
    ].join('\n');
}

function historyLine(history: CheckedCommit[] | undefined): string[] {
    const shown = (history ?? []).slice(-MAX_HISTORY);
    if (!shown.length) {
        return [];
    }
    const steps = shown.map(
        (c) =>
            `\`${c.headSha.slice(0, 7)}\` ${c.met}/${c.total} met${
                c.passed === false ? ' ✗' : c.passed ? ' ✓' : ''
            }`,
    );
    return [`<sub>Earlier checks: ${steps.join(' → ')}</sub>`, ''];
}

function renderTaskSection(check: TaskCheck, context: RenderContext): string {
    const { task, verdict } = check;
    const lines: string[] = [
        `**${taskTitle(task.id, task.title, task.url)}**`,
        headline(check, context.failOn),
    ];
    const meta = [`Task read ${formatDate(check.readAt)}`];
    if (context.headSha) {
        const on = `\`${context.headSha.slice(0, 7)}\``;
        meta.push(
            context.trigger === 'command'
                ? `re-checked on request at ${on}`
                : context.trigger === 'push'
                  ? `re-checked after the push of ${on}`
                  : context.trigger === 'recheck'
                    ? `re-checked at ${on} once the task tracker answered again`
                    : `at ${on}`,
        );
    }
    lines.push(`<sub>${meta.join(' · ')}</sub>`, '');

    const rows = [
        ...(verdict.requirements ?? []).map(requirementRow),
        ...(verdict.outOfScope ?? []).map((change) =>
            outOfScopeRow(change, task.id),
        ),
    ];
    if (rows.length) {
        lines.push('| | Requirement | In this PR |', '|---|---|---|', ...rows);
    } else if (verdict.summary) {
        // A model that answered in prose: show what it said.
        lines.push(verdict.summary);
    }
    if (verdict.scopeMismatch) {
        lines.push(
            '',
            `> This PR seems to work on something other than ${task.id}. If it belongs to another task, reference that one instead.`,
        );
    }
    if (check.reference?.intent === 'part_of') {
        lines.push(
            '',
            `> This PR says it is part of ${task.id}: what's missing is listed, but not as something to merge.`,
        );
    }
    return lines.join('\n');
}

/**
 * Which open findings keep the PR from passing under the team's "fails
 * on" choice. Without it, every kind counts, as before the choice existed.
 */
function blocking(check: TaskCheck, failOn?: readonly FailOnState[]) {
    const slice = check.reference?.intent === 'part_of';
    const on = (state: FailOnState) => !failOn || failOn.includes(state);
    return {
        missing: on('missing') && !slice,
        partial: on('partial') && !slice,
        notInTask: on('not_in_task'),
    };
}

function headline(check: TaskCheck, failOn?: readonly FailOnState[]): string {
    const blockers = countBlockers(check.verdict);
    const manual = (check.verdict.requirements ?? []).filter(
        (r) => r.state === 'check_manually',
    ).length;
    const blocks = blocking(check, failOn);
    const found = [
        {
            n: blockers.missing,
            text: plural(blockers.missing, 'missing requirement'),
            blocks: blocks.missing,
        },
        {
            n: blockers.partial,
            text: `${blockers.partial} partial`,
            blocks: blocks.partial,
        },
        { n: manual, text: `${manual} to check manually`, blocks: false },
        {
            n: blockers.notInTask,
            text: plural(
                blockers.notInTask,
                'change not in the task',
                'changes not in the task',
            ),
            blocks: blocks.notInTask,
        },
    ].filter((f) => f.n);

    if (!blockers.missing && !blockers.partial && !blockers.notInTask) {
        return manual
            ? `All requirements met · ${manual} to check manually`
            : 'All requirements met';
    }
    const toMerge = found.filter((f) => f.blocks).map((f) => f.text);
    const rest = found.filter((f) => !f.blocks).map((f) => f.text);
    if (check.passed || !toMerge.length) {
        return found.map((f) => f.text).join(' · ');
    }
    // Only what the team fails on is "to merge"; the rest is still listed.
    return rest.length
        ? `To merge: ${toMerge.join(' · ')} · also open: ${rest.join(' · ')}`
        : `To merge: ${toMerge.join(' · ')}`;
}

function requirementRow(requirement: RequirementVerdict): string {
    const label = requirement.accepted
        ? `☑️ **${requirement.state.toUpperCase().replace('_', ' ')} · ACCEPTED**`
        : STATE_LABEL[requirement.state];
    const detail: string[] = [];
    if (requirement.accepted) {
        detail.push(acceptanceText(requirement.accepted));
    } else {
        if (requirement.evidence.length) {
            detail.push(locations(requirement.evidence));
        }
        if (requirement.note) {
            detail.push(requirement.note);
        }
        if (requirement.downgraded) {
            detail.push(`_${DOWNGRADE_NOTE[requirement.downgraded]}_`);
        }
        if (
            requirement.action &&
            (requirement.state === 'missing' || requirement.state === 'partial')
        ) {
            detail.push(`**Do:** ${requirement.action}`);
        }
        if (
            requirement.previousState &&
            requirement.previousState !== requirement.state
        ) {
            detail.push(`_was ${requirement.previousState.replace('_', ' ')}_`);
        }
    }
    const name = requirement.source
        ? `${requirement.requirement} <sub>${requirement.source}</sub>`
        : requirement.requirement;
    return `| ${label} | ${cell(name)} | ${cell(detail.join(' · '))} |`;
}

function outOfScopeRow(change: OutOfScopeChange, taskId: string): string {
    const label = change.accepted
        ? '☑️ **NOT IN TASK · ACCEPTED**'
        : '➕ **NOT IN TASK**';
    const detail = change.accepted
        ? [acceptanceText(change.accepted)]
        : [
              change.evidence.length ? locations(change.evidence) : '',
              `${taskId} doesn't ask for it.`,
              change.action ??
                  'Revert it, or reference the task that asks for it.',
          ].filter(Boolean);
    return `| ${label} | ${cell(change.change)} | ${cell(detail.join(' · '))} |`;
}

function acceptanceText(accepted: NonNullable<RequirementVerdict['accepted']>) {
    return [
        `Accepted by @${accepted.by}`,
        accepted.movedTo ? `moved to ${accepted.movedTo}` : '',
        accepted.reason ?? '',
    ]
        .filter(Boolean)
        .join(' · ');
}

function locations(evidence: CodeLocation[]): string {
    return evidence
        .slice(0, 3)
        .map((l) => `\`${location(l)}\``)
        .join(', ');
}

function location(l: CodeLocation): string {
    return `${l.file}${l.line ? `:${l.line}` : ''}`;
}

function taskTitle(id: string, title?: string, url?: string): string {
    const text = title ? `${id} · ${title}` : id;
    return url ? `[${escapeLinkText(text)}](${url})` : text;
}

function cell(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n+/g, ' ')
        .trim();
}

function escapeLinkText(text: string): string {
    return text.replace(/[\\[\]]/g, '\\$&');
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? iso
        : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** What the CLI prints: one line per requirement, as a coding agent reads it (UC-41). */
export function renderCliText(outcome: BusinessValidationOutcome): string {
    if (outcome.kind !== 'validated') {
        return outcome.message;
    }
    const lines: string[] = [];
    for (const check of outcome.checks) {
        lines.push(
            `${check.task.id}${check.task.title ? ` · ${check.task.title}` : ''} (${check.task.tracker})`,
        );
        for (const r of check.verdict.requirements ?? []) {
            const where = r.evidence.length
                ? ` ${r.evidence.map(location).join(', ')}`
                : '';
            const why = r.note ? ` — ${r.note}` : '';
            const fix =
                r.action && (r.state === 'missing' || r.state === 'partial')
                    ? ` → ${r.action}`
                    : '';
            lines.push(
                `  ${r.state.toUpperCase().replace('_', ' ').padEnd(14)} ${r.source ? `${r.source} ` : ''}${r.requirement}${where}${why}${fix}`,
            );
        }
        for (const c of check.verdict.outOfScope ?? []) {
            const where = c.evidence.length
                ? ` ${c.evidence.map(location).join(', ')}`
                : '';
            lines.push(`  ${'NOT IN TASK'.padEnd(14)} ${c.change}${where}`);
        }
    }
    lines.push(
        '',
        `status: ${outcome.passed ? 'compliant' : 'issues_found'} (--json for the full verdict)`,
    );
    return lines.join('\n');
}
