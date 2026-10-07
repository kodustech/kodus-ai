import type {
    BusinessValidationOutcome,
    TaskCheck,
} from './business-validation.types';
import { countBlockers } from './check-policy';
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
}

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
        `<sub>Disagree with a line? Reply here and mention @kody. Fixed it? Comment \`${RERUN_COMMAND}\` and this comment is updated.</sub>`,
    ].join('\n');
}

function renderTaskSection(check: TaskCheck, context: RenderContext): string {
    const { task, verdict } = check;
    const lines: string[] = [
        `**${taskTitle(task.id, task.title, task.url)}**`,
        headline(check),
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
            `> This PR says it is part of ${task.id}: what's missing is listed, but doesn't fail the check.`,
        );
    }
    return lines.join('\n');
}

function headline(check: TaskCheck): string {
    const blockers = countBlockers(check.verdict);
    const manual = (check.verdict.requirements ?? []).filter(
        (r) => r.state === 'check_manually',
    ).length;
    const parts = [
        blockers.missing && plural(blockers.missing, 'missing requirement'),
        blockers.partial && `${blockers.partial} partial`,
        manual && `${manual} to check manually`,
        blockers.notInTask &&
            plural(
                blockers.notInTask,
                'change not in the task',
                'changes not in the task',
            ),
    ].filter(Boolean) as string[];

    if (!blockers.missing && !blockers.partial && !blockers.notInTask) {
        return manual
            ? `All requirements met · ${manual} to check manually`
            : 'All requirements met';
    }
    return check.passed ? parts.join(' · ') : `To merge: ${parts.join(' · ')}`;
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
        .map((l) => `\`${l.file}${l.line ? `:${l.line}` : ''}\``)
        .join(', ');
}

function taskTitle(id: string, title?: string, url?: string): string {
    const text = title ? `${id} · ${title}` : id;
    return url ? `[${escapeLinkText(text)}](${url})` : text;
}

function cell(text: string): string {
    return text
        .replace(/\|/g, '\\|')
        .replace(/\r?\n+/g, ' ')
        .trim();
}

function escapeLinkText(text: string): string {
    return text.replace(/[[\]]/g, '\\$&');
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

/** The check run's title: one line saying what blocks the merge, or that nothing does. */
export function renderCheckTitle(
    outcome: Extract<BusinessValidationOutcome, { kind: 'validated' }>,
): string {
    const failing = outcome.checks.filter((c) => !c.passed);
    if (!failing.length) {
        const manual = outcome.checks.reduce(
            (n, c) =>
                n +
                (c.verdict.requirements ?? []).filter(
                    (r) => r.state === 'check_manually',
                ).length,
            0,
        );
        const ids = outcome.checks.map((c) => c.task.id).join(', ');
        return manual
            ? `${ids} met · ${manual} to check manually`
            : `${ids} met`;
    }
    return failing
        .map((c) => {
            const b = countBlockers(c.verdict);
            const what = [
                b.missing && plural(b.missing, 'requirement') + ' missing',
                b.partial && `${b.partial} partial`,
                b.notInTask &&
                    plural(b.notInTask, 'change') + ' not in the task',
            ].filter(Boolean);
            return `${c.task.id}: ${what.join(', ') || 'scope mismatch'}`;
        })
        .join(' · ');
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
                ? ` ${r.evidence.map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`).join(', ')}`
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
                ? ` ${c.evidence.map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`).join(', ')}`
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
