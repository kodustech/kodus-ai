import { randomBytes } from 'crypto';

import type { TaskLinks } from '../business-validation.types';
import { asRecord } from '../value-utils';
import { MAX_DOCUMENTS, MAX_RELATED_CHARS } from './tracker';

/**
 * Maps the artifacts of a GitHub issue (KODUS_GET_ISSUE `artifacts` and
 * `unreadArtifacts`) onto the documents `McpTaskTracker.relate` already
 * folds into the task, plus a note naming what was not read. Isolated so
 * another approach can replace it without touching the tracker.
 */
export interface IssueArtifactContext {
    documents: NonNullable<TaskLinks['documents']>;
    /**
     * Present when some artifact was not read in full: plain sentences for
     * `Task.coverageNotes`, never part of the description or its criteria.
     */
    coverageNotes?: string[];
    /** Raw text of each document folded in, for criteria detection. */
    sourceTexts: Array<{ label: string; text: string }>;
}

const CUT = '… (cut)';

/** One line of untrusted text, safe to put in a label. */
function inline(value: string): string {
    return value
        .replace(/[\r\n]+/g, ' ')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, 120);
}

/**
 * `text` cut to at most `max` UTF-16 units, never ending on the first half
 * of a surrogate pair.
 */
function cutAt(text: string, max: number): string {
    let end = Math.min(Math.max(0, max), text.length);
    if (end < text.length && end > 0) {
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
            end -= 1;
        }
    }
    return text.slice(0, end);
}

/** A fence name the content cannot contain, so it cannot close the block early. */
function fenceName(content: string): string {
    let name: string;
    do {
        name = `artifact_data_${randomBytes(8).toString('hex')}`;
    } while (content.includes(name));
    return name;
}

/**
 * Artifact text is data, never instructions: it sits in a fence whose name
 * is random per block, closing tags are escaped and every line is quoted, so
 * it cannot end its block or pose as a prompt section header. The block is
 * clipped here, with its closing tag intact, to fit the document limit
 * `relate` applies. When clipped, only whole lines are kept (a first line
 * longer than the limit is cut), and `source` holds exactly the raw lines
 * shown, so criteria are never read from text the judge does not see.
 */
function delimited(content: string): {
    text: string;
    source: string;
    truncated: boolean;
} {
    const name = fenceName(content);
    const open = `<${name}>\n`;
    const close = `\n</${name}>`;
    const lines = content.split(/\r\n|[\r\n\u0085\u2028\u2029]/);
    const quoted = lines.map(
        (line) => `> ${line.replace(/<\s*\/\s*/g, '&lt;/')}`,
    );
    const budget = MAX_RELATED_CHARS - open.length - close.length;
    const whole = quoted.join('\n');
    if (whole.length <= budget) {
        return {
            text: `${open}${whole}${close}`,
            source: lines.join('\n'),
            truncated: false,
        };
    }
    const room = budget - CUT.length;
    let used = 0;
    let kept = 0;
    while (
        kept < quoted.length &&
        used + (kept ? 1 : 0) + quoted[kept].length <= room
    ) {
        used += (kept ? 1 : 0) + quoted[kept].length;
        kept += 1;
    }
    const body = kept ? quoted.slice(0, kept).join('\n') : cutAt(whole, room);
    return {
        text: `${open}${body}${CUT}${close}`,
        source: lines.slice(0, kept).join('\n'),
        truncated: true,
    };
}

export function artifactContext(
    issue: Record<string, unknown>,
): IssueArtifactContext | undefined {
    const unread: string[] = [];
    const documents: IssueArtifactContext['documents'] = [];
    const sourceTexts: IssueArtifactContext['sourceTexts'] = [];
    const labelOf = (number: unknown, name: unknown) =>
        [
            typeof number === 'number' ? `artifact #${number}` : 'an artifact',
            typeof name === 'string' && name.trim() ? inline(name) : undefined,
        ]
            .filter(Boolean)
            .join(' ');

    if (issue.artifacts !== undefined && !Array.isArray(issue.artifacts)) {
        unread.push('the artifact list (unreadable response)');
    }
    for (const entry of Array.isArray(issue.artifacts) ? issue.artifacts : []) {
        const a = asRecord(entry);
        const label = labelOf(a.number, a.name);
        if (
            typeof a.number !== 'number' ||
            typeof a.name !== 'string' ||
            typeof a.content !== 'string' ||
            !a.content.trim()
        ) {
            unread.push(`${label} (invalid or empty)`);
        } else if (documents.length >= MAX_DOCUMENTS) {
            unread.push(`${label} (over the ${MAX_DOCUMENTS}-document limit)`);
        } else {
            const shown = delimited(a.content);
            documents.push({ id: label, title: label, content: shown.text });
            if (shown.source.trim()) {
                sourceTexts.push({ label, text: shown.source });
            }
            if (shown.truncated) {
                unread.push(
                    `${label} (only read in part, cut at the size limit)`,
                );
            }
        }
    }
    if (
        issue.unreadArtifacts !== undefined &&
        !Array.isArray(issue.unreadArtifacts)
    ) {
        // Fail closed: a list of unread artifacts we cannot read is not "none".
        unread.push('the artifact list could not be verified');
    }
    for (const entry of Array.isArray(issue.unreadArtifacts)
        ? issue.unreadArtifacts
        : []) {
        const u = asRecord(entry);
        if (u.reason === 'may_have_more') {
            unread.push('more artifacts may exist beyond the first 100 listed');
            continue;
        }
        const reason = [
            typeof u.reason === 'string' ? inline(u.reason) : 'unknown',
            typeof u.status === 'number' ? `HTTP ${u.status}` : undefined,
        ]
            .filter(Boolean)
            .join(', ');
        unread.push(`${labelOf(u.number, u.name)} (${reason})`);
    }

    if (!documents.length && !unread.length) {
        return undefined;
    }
    return {
        documents,
        sourceTexts,
        ...(unread.length
            ? {
                  coverageNotes: [
                      `Coverage incomplete: not every artifact of this issue was read (${unread.join('; ')}). What they contain is unknown, so do not assume it.`,
                  ],
              }
            : {}),
    };
}
