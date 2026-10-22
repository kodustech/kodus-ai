import { matchAllWithin } from '@libs/common/utils/safe-regex';

import type {
    ReferenceIntent,
    ReferenceSource,
    TaskReference,
} from './business-validation.types';

export type ReferenceSources = Partial<Record<ReferenceSource, string>>;

const SOURCE_ORDER: ReferenceSource[] = ['command', 'title', 'branch', 'body'];

type Match = { index: number; end: number; reference: TaskReference };
type Candidate = TaskReference extends infer R
    ? R extends TaskReference
        ? Omit<R, 'intent'>
        : never
    : never;

/** Words right before a reference that say the PR finishes the task. */
const CLOSES =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?|complete[sd]?)\b[\s:]*$/i;
/** Words that say the PR delivers only a slice of it. */
const PART_OF = /\b(?:part\s+of|partially|partial|parte\s+de)\b[\s:]*$/i;
/**
 * Words that only cite a task: `see KOD-12 for context` is not the PR's work,
 * and `Refs: SAA-96` alone is how some teams name the PR's own task, so these
 * read as a mention, judged only when the PR states nothing else.
 */
const MENTIONS =
    /\b(?:refs?|references?|related\s+to|relates\s+to|towards?|see|relacionad[oa]\s+a)\b[\s:]*$/i;

const SUMMARY_START = '<!-- kody-pr-summary:start -->';
const SUMMARY_END = '<!-- kody-pr-summary:end -->';

/**
 * The description without the PR summary Kody writes into it: generated
 * text, so an id in it (a team's summary template, a task the model mentions)
 * is not a task the author named. One pass over the text; a start with no end
 * is left as it is.
 */
function withoutKodySummary(body: string): string {
    let out = '';
    let at = 0;
    for (;;) {
        const start = body.indexOf(SUMMARY_START, at);
        if (start < 0) {
            return out + body.slice(at);
        }
        const end = body.indexOf(SUMMARY_END, start + SUMMARY_START.length);
        if (end < 0) {
            return out + body.slice(at);
        }
        out += body.slice(at, start);
        at = end + SUMMARY_END.length;
    }
}

/**
 * Every task a PR could be pointing at, in the order a person would read
 * them: what the command was given, then the title, the branch and the body.
 *
 * This only finds candidates. `UTF-8` is read as a key here on purpose: a
 * reference counts once a tracker returns a task with that id, so a rule that
 * tried to tell keys from version numbers would only move the false positives.
 */
export function extractTaskReferences(
    sources: ReferenceSources,
    options: { taskIdPattern?: string } = {},
): TaskReference[] {
    const byKey = new Map<string, TaskReference>();
    const references: TaskReference[] = [];

    for (const source of SOURCE_ORDER) {
        const text =
            source === 'body'
                ? withoutKodySummary(sources.body ?? '')
                : sources[source];
        if (!text?.trim()) {
            continue;
        }
        for (const reference of extractFromText(
            text,
            source,
            options.taskIdPattern,
        )) {
            const key = `${reference.kind}:${reference.id}:${
                'repository' in reference && reference.repository
                    ? `${reference.repository.owner}/${reference.repository.name}`
                    : ''
            }`;
            const earlier = byKey.get(key);
            if (!earlier) {
                byKey.set(key, reference);
                references.push(reference);
                continue;
            }
            // "feat(SAA-96)" in the title and "Part of SAA-96" in the body:
            // the PR said it delivers a slice, so that is what counts.
            earlier.intent = strongerIntent(earlier.intent, reference.intent);
            // `feat(kod-10)` in the title and `nina/kod-10-…` as the branch:
            // stated where keys are trusted, it is no longer loose.
            if (
                earlier.kind === 'key' &&
                earlier.loose &&
                !(reference.kind === 'key' && reference.loose)
            ) {
                delete earlier.loose;
            }
            // `fix/12-add-login` and "Closes #12": the PR named the issue
            // outright, so its title no longer has to match.
            if (
                earlier.kind === 'git_issue' &&
                earlier.titleHint &&
                !(reference.kind === 'git_issue' && reference.titleHint)
            ) {
                delete earlier.titleHint;
            }
        }
    }

    return references;
}

function strongerIntent(
    a: ReferenceIntent,
    b: ReferenceIntent,
): ReferenceIntent {
    if (a === 'part_of' || b === 'part_of') {
        return 'part_of';
    }
    return a === 'closes' || b === 'closes' ? 'closes' : 'mentions';
}

/**
 * How a reference reads back to a person: `#12` for an issue a branch named
 * `gh12` or `12-add-login`, never the fragment it was cut from.
 */
export function referenceLabel(reference: TaskReference): string {
    switch (reference.kind) {
        case 'git_issue':
            return reference.repository
                ? `${reference.repository.owner}/${reference.repository.name}#${reference.id}`
                : `#${reference.id}`;
        case 'work_item':
            return `AB#${reference.id}`;
        case 'key':
            return reference.id;
        case 'page':
            return reference.raw;
    }
}

/**
 * The references a validation should judge. Ones the PR states (in the
 * command, title or branch, or after "Closes" / "Part of") win over ones the
 * body only mentions. More than `max` of them is a release or a merge, not one
 * task's work, and returns `undefined` (UC-17).
 */
export function selectReferences(
    references: TaskReference[],
    max: number,
): TaskReference[] | undefined {
    const stated = references.filter(
        (r) => r.source !== 'body' || r.intent !== 'mentions',
    );
    // A `#45` the body only mentions is another issue or PR far more often
    // than the PR's own task: it is never judged unless the PR states it.
    const chosen = stated.length
        ? stated
        : references.filter((r) => r.kind !== 'git_issue');
    return chosen.length > max ? undefined : chosen;
}

function intentBefore(
    text: string,
    index: number,
    source: ReferenceSource,
): ReferenceIntent {
    // The 40 characters before it, on its own line.
    const window = text.slice(Math.max(0, index - 40), index);
    const before = window.slice(window.lastIndexOf('\n') + 1);
    if (PART_OF.test(before)) {
        return 'part_of';
    }
    if (MENTIONS.test(before)) {
        return 'mentions';
    }
    if (CLOSES.test(before)) {
        return 'closes';
    }
    // A task named in the title, branch or command is the PR's own task.
    return source === 'body' ? 'mentions' : 'closes';
}

/** How much of one text a team's own pattern runs on, so no pattern can stall a review. */
const MAX_PATTERN_INPUT = 20_000;

function extractFromText(
    text: string,
    source: ReferenceSource,
    taskIdPattern?: string,
): TaskReference[] {
    const matches: Match[] = [];
    // One flag per character a reference already read: an overlap test costs
    // the match's length, not a scan of every match so far.
    const claimed = new Uint8Array(text.length);
    const taken = (index: number, end: number) =>
        claimed.subarray(index, end).includes(1);
    const claim = (index: number, end: number) => {
        claimed.fill(1, index, end);
    };
    const collect = (
        pattern: RegExp,
        toReference: (m: RegExpExecArray) => Candidate | undefined,
        notATask: (index: number, end: number) => void = claim,
    ) => {
        for (const m of text.matchAll(pattern)) {
            const index = m.index ?? 0;
            const end = index + m[0].length;
            if (taken(index, end)) {
                continue;
            }
            const candidate = toReference(m);
            if (!candidate) {
                notATask(index, end);
                continue;
            }
            claim(index, end);
            matches.push({
                index,
                end,
                reference: {
                    ...candidate,
                    intent: intentBefore(text, index, source),
                } as TaskReference,
            });
        }
    };

    // A URL that is not a task still claims its text, so the `/70` of a pull
    // request link is never read again as `#70`. It does so after the team's
    // pattern, which may read its ids from a link (`…/story/123`).
    const urlsNotTasks: Array<[number, number]> = [];
    collect(
        /https?:\/\/[^\s<>()[\]"'`]+/gi,
        (m) => fromUrl(trimUrl(m[0]), source),
        (index, end) => urlsNotTasks.push([index, end]),
    );
    // `P-KOD-1` is a Linear project, not task KOD-1: it claims its text too.
    collect(
        /(?<![A-Za-z0-9_-])P-[A-Za-z][A-Za-z0-9_]*-\d+(?![A-Za-z0-9_])/gi,
        () => undefined,
    );
    if (taskIdPattern) {
        // The team's own shape (`sc-123`, `T1234`) claims its text before the
        // built-in ones: its first group, when it has one, is the id. The
        // pattern already passed `isRegexSafe` and compiled in
        // `resolveBusinessLogicSettings`; it runs with a time limit, since
        // the text is the PR's, written by its author.
        for (const m of matchAllWithin(
            taskIdPattern,
            text.slice(0, MAX_PATTERN_INPUT),
        )) {
            const id = (m.group ?? m.text).trim();
            const { index } = m;
            const end = index + m.text.length;
            if (id && !taken(index, end)) {
                claim(index, end);
                matches.push({
                    index,
                    end,
                    reference: {
                        kind: 'key',
                        id,
                        raw: m.text,
                        source,
                        intent: intentBefore(text, index, source),
                        teamPattern: true,
                    },
                });
            }
        }
    }
    for (const [index, end] of urlsNotTasks) {
        claim(index, end);
    }
    collect(/(?<![A-Za-z0-9_])AB#(\d+)\b/gi, (m) => ({
        kind: 'work_item',
        id: m[1],
        raw: m[0],
        source,
    }));
    collect(
        /(?<![\w./-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g,
        (m) => ({
            kind: 'git_issue',
            id: m[3],
            raw: m[0],
            source,
            repository: { owner: m[1], name: m[2] },
        }),
    );
    collect(/(?<![\w&#])#(\d+)\b/g, (m) => ({
        kind: 'git_issue',
        id: m[1],
        raw: m[0],
        source,
    }));
    if (source === 'branch') {
        // `12-add-login`, the branch GitHub and GitLab create from issue #12,
        // and `issue-12` / `gh-12`, which say so.
        collect(/^(\d{1,6})(?=[-_][A-Za-z])/g, (m) => ({
            kind: 'git_issue',
            id: m[1],
            raw: m[0],
            source,
        }));
        collect(
            /(?<![A-Za-z0-9])(?:issues?|gh)[-_#]?(\d{1,6})(?!\d)/gi,
            (m) => ({
                kind: 'git_issue',
                id: m[1],
                raw: m[0],
                source,
            }),
        );
        // `feature/12-add-login`: after a prefix a number is a status code or
        // a name as often as an issue (`fix/404-on-login`), so the issue
        // counts only if its title shares a word with the rest of the name.
        collect(/(?<=\/)(\d{1,6})[-_]([A-Za-z][A-Za-z0-9_-]*)/g, (m) => ({
            kind: 'git_issue',
            id: m[1],
            raw: m[0],
            source,
            titleHint: m[2],
        }));
    }
    // ClickUp's GitHub integration names a task `CU-<id>` in branches,
    // titles and commits (`feature/CU-86bcjxxuu-bulk-archive`).
    collect(/(?<![A-Za-z0-9_])CU-([a-z0-9]{6,12})(?![A-Za-z0-9_])/gi, (m) => ({
        kind: 'key',
        id: m[1].toLowerCase(),
        raw: m[0],
        source,
        host: 'clickup',
    }));
    // Trackers write keys in capitals; a branch or a typed command lowercases
    // them (`nina/saa-96-sticky-notes`). In prose, `gpt-5` and `node-22` are
    // names far more often than `feat(kod-10)` is a task, so a lower-case key
    // there is loose: the resolver keeps it only where a tracker has the team.
    const lowercase = source === 'branch' || source === 'command';
    collect(
        /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)-(\d+)(?![A-Za-z0-9_])/g,
        (m) => ({
            kind: 'key',
            id: `${m[1]}-${m[2]}`,
            raw: m[0],
            source,
        }),
    );
    collect(
        /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*)-(\d+)(?![A-Za-z0-9_])/g,
        (m) => ({
            kind: 'key',
            id: `${m[1].toUpperCase()}-${m[2]}`,
            raw: m[0],
            source,
            ...(lowercase ? {} : { loose: true as const }),
        }),
    );

    return matches.sort((a, b) => a.index - b.index).map((m) => m.reference);
}

function fromUrl(url: string, source: ReferenceSource): Candidate | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    let path: string;
    try {
        path = decodeURIComponent(parsed.pathname);
    } catch {
        return undefined;
    }

    if (host === 'linear.app' || host.endsWith('.linear.app')) {
        const key = path.match(/\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/)?.[1];
        return key
            ? {
                  kind: 'key',
                  id: key.toUpperCase(),
                  raw: url,
                  source,
                  host: 'linear',
                  url,
              }
            : undefined;
    }

    if (host.endsWith('.atlassian.net') || host.startsWith('jira.')) {
        const key =
            parsed.searchParams.get('selectedIssue') ??
            path.match(/\/(?:browse|issues)\/([A-Za-z][A-Za-z0-9_]*-\d+)/)?.[1];
        return key && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)
            ? {
                  kind: 'key',
                  id: key.toUpperCase(),
                  raw: url,
                  source,
                  host: 'jira',
                  url,
              }
            : undefined;
    }

    if (host === 'app.clickup.com' || host === 'sharing.clickup.com') {
        // A task is /t/<id> or /t/<workspace>/<custom id>; chat threads
        // (/v/cn/.../t/<id>) end in a message id, not a task.
        const task = /^\/t\/(?:\d+\/)?([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/.exec(
            path,
        );
        return task
            ? {
                  kind: 'key',
                  id: task[1],
                  raw: url,
                  source,
                  host: 'clickup',
                  url,
              }
            : undefined;
    }
    if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
        const id = path.match(/\/_workitems\/edit\/(\d+)/i)?.[1];
        return id
            ? { kind: 'work_item', id, raw: url, source, url }
            : undefined;
    }

    if (host.endsWith('notion.so') || host.endsWith('notion.site')) {
        const id = path.replace(/-/g, '').match(/([0-9a-f]{32})(?:\/)?$/i)?.[1];
        return id
            ? { kind: 'page', id: id.toLowerCase(), raw: url, source, url }
            : undefined;
    }

    // GitHub, GitLab (`/-/issues/`), Bitbucket, Forgejo: …/<owner>/<repo>/issues/<n>.
    const issue = path.match(/^\/(.+?)\/([^/]+)(?:\/-)?\/issues\/(\d+)\/?$/);
    if (issue) {
        const owner = issue[1];
        return {
            kind: 'git_issue',
            id: issue[3],
            raw: url,
            source,
            repository: { owner, name: issue[2] },
            url,
        };
    }

    return undefined;
}

function trimUrl(url: string): string {
    return url.replace(/[.,;:!?]+$/, '');
}
