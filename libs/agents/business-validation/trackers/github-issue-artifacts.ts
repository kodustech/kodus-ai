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
}

const CUT = '… (cut)';
/** Unread artifacts named in the note; the rest are counted. */
const MAX_NAMED = 5;

/** One line of untrusted text, safe to put in a label. */
function inline(value: string): string {
    return value
        .replace(/[\r\n]+/g, ' ')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, 120);
}

/**
 * Artifact text is data, never instructions: closing tags are escaped and
 * every line is quoted, so it cannot end its block or pose as a prompt
 * section header. The block is clipped here, with its closing tag intact,
 * to fit the document limit `relate` applies.
 */
function delimited(content: string): string {
    const open = '<artifact_data>\n';
    const close = '\n</artifact_data>';
    const quoted = content
        .replace(/<\s*\/\s*/g, '&lt;/')
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
    const room = MAX_RELATED_CHARS - open.length - close.length - CUT.length;
    return `${open}${quoted.length > MAX_RELATED_CHARS - open.length - close.length ? `${quoted.slice(0, room)}${CUT}` : quoted}${close}`;
}

export function artifactContext(
    issue: Record<string, unknown>,
): IssueArtifactContext | undefined {
    const unread: string[] = [];
    const documents: IssueArtifactContext['documents'] = [];
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
            const text = delimited(a.content);
            documents.push({ id: label, title: label, content: text });
            if (text.endsWith(`${CUT}\n</artifact_data>`)) {
                unread.push(
                    `${label} (only read in part, cut at the size limit)`,
                );
            }
        }
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
        ...(unread.length
            ? {
                  coverageNotes: [
                      `Coverage incomplete: not every artifact of this issue was read (${unread.slice(0, MAX_NAMED).join('; ')}${unread.length > MAX_NAMED ? `; and ${unread.length - MAX_NAMED} more` : ''}). What they contain is unknown, so do not assume it.`,
                  ],
              }
            : {}),
    };
}
