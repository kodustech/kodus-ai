import type {
    ReferenceIntent,
    ReferenceSource,
    TaskReference,
} from './business-validation.types';

export type ReferenceSources = Partial<Record<ReferenceSource, string>>;

const SOURCE_ORDER: ReferenceSource[] = ['command', 'title', 'branch', 'body'];

type Match = { index: number; end: number; reference?: TaskReference };
type Candidate = TaskReference extends infer R
    ? R extends TaskReference
        ? Omit<R, 'intent'>
        : never
    : never;

/** Words right before a reference that say the PR finishes the task. */
const CLOSES =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?|complete[sd]?)\b[\s:]*$/i;
/** Words that say the PR delivers only a slice of it. */
const PART_OF =
    /\b(?:part\s+of|partially|partial|refs?|references?|related\s+to|relates\s+to|towards?|see|parte\s+de|relacionad[oa]\s+a)\b[\s:]*$/i;

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
): TaskReference[] {
    const byKey = new Map<string, TaskReference>();
    const references: TaskReference[] = [];

    for (const source of SOURCE_ORDER) {
        const text = sources[source];
        if (!text?.trim()) {
            continue;
        }
        for (const reference of extractFromText(text, source)) {
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
    const chosen = stated.length ? stated : references;
    return chosen.length > max ? undefined : chosen;
}

function intentBefore(
    text: string,
    index: number,
    source: ReferenceSource,
): ReferenceIntent {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const before = text.slice(Math.max(lineStart, index - 40), index);
    if (PART_OF.test(before)) {
        return 'part_of';
    }
    if (CLOSES.test(before)) {
        return 'closes';
    }
    // A task named in the title, branch or command is the PR's own task.
    return source === 'body' ? 'mentions' : 'closes';
}

function extractFromText(
    text: string,
    source: ReferenceSource,
): TaskReference[] {
    const matches: Match[] = [];
    const taken = (index: number, end: number) =>
        matches.some((m) => index < m.end && end > m.index);
    const collect = (
        pattern: RegExp,
        toReference: (m: RegExpExecArray) => Candidate | undefined,
    ) => {
        for (const m of text.matchAll(pattern)) {
            const index = m.index ?? 0;
            const end = index + m[0].length;
            if (taken(index, end)) {
                continue;
            }
            // A URL that is not a task still claims its text, so the `/70` of
            // a pull request link is never read again as `#70`.
            const candidate = toReference(m);
            matches.push({
                index,
                end,
                reference: candidate
                    ? ({
                          ...candidate,
                          intent: intentBefore(text, index, source),
                      } as TaskReference)
                    : undefined,
            });
        }
    };

    collect(/https?:\/\/[^\s<>()[\]"'`]+/gi, (m) =>
        fromUrl(trimUrl(m[0]), source),
    );
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
    collect(
        /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*)-(\d+)(?![A-Za-z0-9_])/g,
        (m) => ({
            kind: 'key',
            id: `${m[1].toUpperCase()}-${m[2]}`,
            raw: m[0],
            source,
        }),
    );

    return matches
        .sort((a, b) => a.index - b.index)
        .map((m) => m.reference)
        .filter((r): r is TaskReference => r !== undefined);
}

function fromUrl(url: string, source: ReferenceSource): Candidate | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    const path = decodeURIComponent(parsed.pathname);

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
