import { truncateKeepingSurrogatePairs } from '@libs/common/utils/truncate-text';

import type { IIssue } from './interfaces/issues.interface';

/** The most characters of a finding's text an exported ticket carries. */
const EXPORT_MAX_DESCRIPTION_CHARS = 4000;

export type ExportedIssue = Pick<
    IIssue,
    | 'uuid'
    | 'title'
    | 'description'
    | 'filePath'
    | 'severity'
    | 'repository'
    | 'cwe'
    | 'symbol'
    | 'startLine'
    | 'endLine'
    | 'evidence'
    | 'occurrences'
>;

/**
 * What a ticket filed in the team's own tool says about a deep scan finding:
 * where it is, every place it shows, what it depends on, how it is reached and
 * the fix, in markdown. The Kody issue id stays in it, so the ticket and the
 * issue can be told apart from any other.
 */
export function buildExportBody(issue: ExportedIssue): string {
    const lines =
        issue.startLine && issue.endLine && issue.endLine !== issue.startLine
            ? `:${issue.startLine}-${issue.endLine}`
            : issue.startLine
              ? `:${issue.startLine}`
              : '';
    const parts = [
        [
            `**Severity:** ${issue.severity}`,
            issue.cwe ? `**${issue.cwe}**` : '',
            issue.repository?.full_name || issue.repository?.name
                ? `**Repository:** ${issue.repository.full_name || issue.repository.name}`
                : '',
        ]
            .filter(Boolean)
            .join(' · '),
        `**Where:** \`${issue.filePath}${lines}\`${issue.symbol ? ` in \`${issue.symbol}\`` : ''}`,
    ];
    const places = issue.occurrences ?? [];
    if (places.length) {
        parts.push(
            `**Also at** (one fix should close all of them):\n${places
                .slice(0, 20)
                .map(
                    (p) =>
                        `- \`${p.filePath}:${p.startLine}${p.endLine !== p.startLine ? `-${p.endLine}` : ''}\` ${p.title}`,
                )
                .join('\n')}`,
        );
    }
    if (issue.evidence?.assumption?.trim()) {
        parts.push(`**Depends on:** ${issue.evidence.assumption.trim()}`);
    }
    const description = (issue.description ?? '').trim();
    if (description) {
        parts.push(
            description.length > EXPORT_MAX_DESCRIPTION_CHARS
                ? `${truncateKeepingSurrogatePairs(description, EXPORT_MAX_DESCRIPTION_CHARS)}\n\n[truncated]`
                : description,
        );
    }
    const path = issue.evidence?.attackPath ?? [];
    if (path.length) {
        parts.push(
            `**How an attacker reaches it:**\n${path
                .slice(0, 12)
                .map((s, i) => `${i + 1}. \`${s.file}:${s.line}\` ${s.note}`)
                .join('\n')}`,
        );
    }
    parts.push(
        `_Found by the Kodus deep scan · Kody issue ${issue.uuid ?? ''}_`,
    );
    return parts.join('\n\n');
}
