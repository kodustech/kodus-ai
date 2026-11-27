import type { Task } from './business-validation.types';
import type { TaskQuality } from './judge/validation.types';
import type { BusinessLogicSettings } from './settings';

/** A description shorter than this, with no criteria, does not say what "done" is. */
const MIN_DESCRIPTION = 80;
/** Below this, a description next to a title adds nothing to judge against. */
const MIN_DESCRIPTION_WORDS = 6;

const wordCount = (text: string) =>
    text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

/**
 * How much the task says, graded once here; the judge never regrades it. A
 * sub-issue that says little on its own ("Archive part of the parent") is
 * judged with its parent: its title scopes what the parent asks.
 */
export function gradeTask(task: Task): TaskQuality {
    const own = gradeOwn(task);
    if (
        (own === 'MINIMAL' || own === 'EMPTY') &&
        task.title?.trim() &&
        task.parent?.description &&
        wordCount(task.parent.description) >= MIN_DESCRIPTION_WORDS
    ) {
        return 'PARTIAL';
    }
    return own;
}

function gradeOwn(task: Task): TaskQuality {
    const title = task.title?.trim() ?? '';
    const description = task.description?.trim() ?? '';
    const criteria = (task.acceptanceCriteria ?? []).filter((c) => c.trim());

    if (!title && !description && !criteria.length) {
        return 'EMPTY';
    }
    if (
        criteria.length ||
        countListItems(withoutOwnArtifactLinks(task, description)) >= 2
    ) {
        return 'COMPLETE';
    }
    // "Improve tickets" / "Make tickets better." says no more than a bare
    // title: a description counts once it says something.
    if (title && wordCount(description) >= MIN_DESCRIPTION_WORDS) {
        return 'PARTIAL';
    }
    if (description) {
        return description.length >= MIN_DESCRIPTION ? 'PARTIAL' : 'MINIMAL';
    }
    return 'MINIMAL';
}

/** True when the judge can compare the code against it. */
export function canJudgeAgainst(quality: TaskQuality): boolean {
    return quality === 'PARTIAL' || quality === 'COMPLETE';
}

/**
 * The task with its acceptance criteria taken from where the team said they
 * live: a heading in the description, or a field (UC-05, UC-23). When that
 * place isn't on this task (a Git issue has no custom fields), they are
 * detected as with "Detect automatically".
 */
export function applyCriteriaLocation(
    task: Task,
    criteria: BusinessLogicSettings['criteria'],
): Task {
    if (criteria.location === 'auto') {
        return detectCriteria(task);
    }
    const text = criteriaPlaceText(task, criteria);
    if (!text) {
        return detectCriteria(task);
    }
    return {
        ...task,
        acceptanceCriteria: withArtifactCriteria(task, criteriaIn(text)),
    };
}

/** The criteria a field or section holds: its list, else one per line. */
function criteriaIn(text: string): string[] {
    const items = listItems(text);
    if (items.length) {
        return items;
    }
    // A field with one criterion per line and no bullets (a Notion property).
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 3);
    return lines.length >= 2 ? lines : [text.trim()];
}

/** What sits where the team said criteria live, when that place is on the task. */
export function criteriaPlaceText(
    task: Task,
    criteria: BusinessLogicSettings['criteria'],
): string | undefined {
    if (criteria.location === 'auto') {
        return undefined;
    }
    const text =
        criteria.location === 'heading'
            ? sectionUnder(task.description ?? '', criteria.heading)
            : fieldText(task, criteria.field);
    return text?.trim() || undefined;
}

/** Headings teams put acceptance criteria under, normalized, most specific first. */
const CRITERIA_HEADINGS = [
    'acceptance criteria',
    'acceptance criterion',
    'ac',
    'definition of done',
    'dod',
    'requirements',
    'criterios de aceite',
    'criterios de aceitacao',
    'criterio de aceite',
    'criterios de aceptacion',
];

/**
 * Auto: the tracker's own criteria field; else the list under a criteria
 * heading; else the description's list when it has two or more items. What
 * the settings page shows is then what the judge reads.
 */
function detectCriteria(task: Task): Task {
    if (task.acceptanceCriteria?.length) {
        return task;
    }
    // A field named for criteria (a Jira "Acceptance Criteria" field) beats
    // a list in the description, which is as often context as criteria. With
    // two of them ("Requirements" and "Acceptance Criteria"), the most
    // specific name wins, not the one the tracker happens to list first.
    const rank = (name: string) => CRITERIA_HEADINGS.indexOf(normalize(name));
    const field = Object.entries(task.fields ?? {})
        .filter(([name, text]) => rank(name) >= 0 && text.trim())
        .sort(([a], [b]) => rank(a) - rank(b))[0];
    if (field) {
        return { ...task, acceptanceCriteria: criteriaIn(field[1]) };
    }
    const description = task.description ?? '';
    const own = ownArtifactLink(task);

    // Explicit criteria, wherever they are: a criteria heading in the
    // description, or in a document read with it, and, when documents were
    // read, AC-labelled items (`AC1: ...`). They beat the implicit list of
    // the description's bullets. All places are kept, deduplicated; those
    // from a document say which.
    const explicit = withArtifactCriteria(
        task,
        uniqueCriteria(
            explicitIn(description, !!task.sourceTexts?.length, own),
        ),
    );
    if (explicit.length) {
        return { ...task, acceptanceCriteria: explicit };
    }
    const items = keepSubstantive(listItems(description), own);
    return items.length >= 2 ? { ...task, acceptanceCriteria: items } : task;
}

/** The explicit criteria of a text: its criteria section, plus its AC-labelled items. */
function explicitIn(
    text: string,
    withLabels: boolean,
    own: RegExp | undefined,
): string[] {
    let section: string[] = [];
    for (const heading of CRITERIA_HEADINGS) {
        const body = sectionUnder(text, heading);
        const items = body ? keepSubstantive(listItems(body), own) : [];
        if (items.length) {
            section = items;
            break;
        }
    }
    const labelled = withLabels
        ? keepSubstantive(listItems(text), own).filter(isLabelledCriterion)
        : [];
    return [...section, ...labelled];
}

const criterionKey = (item: string) =>
    normalize(item.replace(CRITERION_LABEL, ''));

/** The items without repeats (by content, ignoring an `AC1:` label), first one wins. */
function uniqueCriteria(items: string[]): string[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = criterionKey(item);
        if (!key || seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/**
 * `criteria` plus the explicit criteria of the documents read with the task
 * (GitHub issue artifacts), each saying which document it is from. Reference
 * lines to the issue's own artifacts are left out. Without documents the
 * criteria are returned as they are.
 */
function withArtifactCriteria(task: Task, criteria: string[]): string[] {
    const documents = task.sourceTexts ?? [];
    if (!documents.length) {
        return criteria;
    }
    const own = ownArtifactLink(task);
    const seen = new Set(criteria.map(criterionKey));
    const merged = [...criteria];
    for (const document of documents) {
        for (const raw of explicitIn(
            flattenLineBreaks(document.text),
            true,
            own,
        )) {
            const item = escapeClosingTags(oneLine(raw));
            const key = criterionKey(item);
            if (key && !seen.has(key)) {
                seen.add(key);
                merged.push(`[${document.label}] ${item}`);
            }
        }
    }
    return merged;
}

/** Every line separator but `\n` (and CRLF) becomes a space, so no item can carry a hidden break. */
function flattenLineBreaks(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/[\r\v\f\u0085\u2028\u2029]+/g, ' ');
}

/** One line: each run of line separators becomes a single space. */
function oneLine(text: string): string {
    return text.replace(/(?:\r\n|[\r\n\v\f\u0085\u2028\u2029])+/g, ' ').trim();
}

/** The same closing-tag escape the quoted document body gets. */
function escapeClosingTags(text: string): string {
    return text.replace(/<\s*\/\s*/g, '&lt;/');
}

/** `AC1: ...`, `AC #2 - ...`, `CA-3) ...`: an item that labels itself a criterion. */
function isLabelledCriterion(item: string): boolean {
    return CRITERION_LABEL.test(item);
}

const CRITERION_LABEL = /^[*_`\s]*(?:AC|CA)[\s#-]*\d+[*_`\s]*[:.)\-–—]\s*/i;

/**
 * A link to an artifact of this very issue (`https://host/owner/repo/issues/
 * 310/artifacts/2`, same host, repository and number), whatever its label or
 * hash. Only when artifacts were read with the task, and only when the task
 * says which issue it is: otherwise nothing is recognised as one's own.
 */
function ownArtifactLink(task: Task): RegExp | undefined {
    if (!task.hasArtifacts || !task.url) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(task.url.trim());
    } catch {
        return undefined;
    }
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
    if (!match || !/^https?:$/.test(url.protocol)) {
        return undefined;
    }
    const escape = (text: string) =>
        text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [, owner, repo, number] = match;
    return new RegExp(
        `https?://${escape(url.host)}/${escape(owner)}/${escape(repo)}/issues/${number}/artifacts/\\d+(?!\\d)`,
        'i',
    );
}

/** Words that make a line only point at a document, not say anything about the code. */
const REFERENCE_WORDS = new Set([
    'see',
    'spec',
    'specs',
    'artifact',
    'artifacts',
    'sha256',
    'source',
    'details',
    'full',
    'read',
    'link',
    'at',
    'in',
    'on',
    'from',
    'the',
    'of',
    'for',
    'and',
    'here',
    'version',
    'file',
]);

/**
 * A line that is only a pointer to an artifact of this issue (a bare link,
 * "see X", a references-list line with a name and a hash). A line that says
 * something and also links one is not.
 */
/**
 * The line with its links to the issue's own artifacts blanked: Markdown
 * `[text](url)` links and bare URLs. One forward scan, never backtracking,
 * so a line of unclosed brackets costs no more than a line of text.
 */
function withoutOwnLinks(line: string, own: RegExp): string {
    let out = '';
    let at = 0;
    let parenGone = false;
    while (at < line.length) {
        const open = line.indexOf('[', at);
        if (open < 0) {
            break;
        }
        const close = line.indexOf(']', open + 1);
        if (close < 0) {
            break;
        }
        let end = -1;
        if (line[close + 1] === '(' && !parenGone) {
            end = line.indexOf(')', close + 2);
            parenGone = end < 0;
        }
        if (end < 0) {
            out += line.slice(at, close + 1);
            at = close + 1;
            continue;
        }
        const link = line.slice(open, end + 1);
        out += line.slice(at, open) + (own.test(link) ? ' ' : link);
        at = end + 1;
    }
    out += line.slice(at);
    return out.replace(/\S+/g, (token) => (own.test(token) ? ' ' : token));
}

function isReferenceOnly(line: string, own: RegExp | undefined): boolean {
    if (!own?.test(line)) {
        return false;
    }
    const rest = withoutOwnLinks(line, own)
        .replace(/`[^`]*`/g, ' ')
        .toLowerCase();
    const words = rest.match(/\p{L}[\p{L}\p{N}._-]*/gu) ?? [];
    return words.every(
        (word) =>
            REFERENCE_WORDS.has(word) ||
            /^v\d+$/.test(word) ||
            /^[\p{L}\p{N}_-]+\.[a-z0-9]{1,5}$/u.test(word),
    );
}

function keepSubstantive(items: string[], own: RegExp | undefined): string[] {
    return own ? items.filter((item) => !isReferenceOnly(item, own)) : items;
}

function sectionUnder(
    description: string,
    heading: string,
): string | undefined {
    const lines = description.split('\n');
    const wanted = normalize(heading);
    const start = lines.findIndex((line) => {
        const match = line.match(/^\s*(?:#{1,6}\s+|\*\*)?(.+?)(?:\*\*)?:?\s*$/);
        return match ? normalize(match[1]) === wanted : false;
    });
    if (start < 0) {
        return undefined;
    }
    const level = (lines[start].match(/^\s*(#{1,6})\s/)?.[1] ?? '').length;
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const next = line.match(/^\s*(#{1,6})\s/);
        if (next && (!level || next[1].length <= level)) {
            break;
        }
        body.push(line);
    }
    const text = body.join('\n').trim();
    return text || undefined;
}

function fieldText(task: Task, field: string): string | undefined {
    const fields = task.fields ?? {};
    const wanted = normalize(field);
    const key = Object.keys(fields).find((k) => normalize(k) === wanted);
    return key ? fields[key] : undefined;
}

function listItems(text: string): string[] {
    return text
        .split('\n')
        .map((line) =>
            line
                .trim()
                .match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+\.\s+)(.+)$/)?.[1]
                ?.trim(),
        )
        .filter((item): item is string => !!item && item.length > 3);
}

function normalize(text: string): string {
    return text
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** The task as the judge reads it. */
export function formatTaskForJudge(task: Task): string {
    const sections = [`Task ID: ${task.id}`];
    if (task.title) {
        sections.push(`Title: ${task.title}`);
    }
    if (task.description) {
        sections.push(`Description:\n${task.description}`);
    }
    if (task.acceptanceCriteria?.length) {
        sections.push(
            `Acceptance Criteria:\n${task.acceptanceCriteria
                .map((item) => `- ${item}`)
                .join('\n')}`,
        );
    }
    if (task.hasAttachments) {
        sections.push(
            'Attachments: the task has images or files that are not shown here. Requirements that depend on them are visual: mark them check_manually.',
        );
    }
    if (task.url) {
        sections.push(`Links:\n- ${task.url}`);
    }
    if (task.coverageNotes?.length) {
        sections.push(`Coverage notes:\n${task.coverageNotes.join('\n')}`);
    }
    return sections.join('\n\n');
}

function withoutOwnArtifactLinks(task: Task, text: string): string {
    const own = ownArtifactLink(task);
    if (!own) {
        return text;
    }
    return text
        .split('\n')
        .filter((line) => !isReferenceOnly(line, own))
        .join('\n');
}

function countListItems(text: string): number {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) =>
            /^(?:[-*]\s+|\d+\.\s+)(?!\[[ xX]\]\s*$).{10,}$/u.test(line),
        ).length;
}
