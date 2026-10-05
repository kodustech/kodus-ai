import type {
    ReferenceSource,
    TaskReference,
} from './business-validation.types';

export type ReferenceSources = Partial<Record<ReferenceSource, string>>;

const SOURCE_ORDER: ReferenceSource[] = ['command', 'title', 'branch', 'body'];

type Match = { index: number; end: number; reference?: TaskReference };

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
    const seen = new Set<string>();
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
            if (!seen.has(key)) {
                seen.add(key);
                references.push(reference);
            }
        }
    }

    return references;
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
        toReference: (m: RegExpExecArray) => TaskReference | undefined,
    ) => {
        for (const m of text.matchAll(pattern)) {
            const index = m.index ?? 0;
            const end = index + m[0].length;
            if (taken(index, end)) {
                continue;
            }
            // A URL that is not a task still claims its text, so the `/70` of
            // a pull request link is never read again as `#70`.
            matches.push({ index, end, reference: toReference(m) });
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

function fromUrl(
    url: string,
    source: ReferenceSource,
): TaskReference | undefined {
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
