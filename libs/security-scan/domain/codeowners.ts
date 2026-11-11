/**
 * CODEOWNERS, as GitHub, GitLab and Bitbucket read it: gitignore-style
 * patterns, the last matching line wins. GitLab sections (`[Backend]`) are
 * read as plain rules, so the last match across the whole file wins — enough
 * to name one owner, which is all a security finding needs.
 */
export const CODEOWNERS_LOCATIONS = [
    '.github/CODEOWNERS',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    '.gitlab/CODEOWNERS',
    '.bitbucket/CODEOWNERS',
];

export interface CodeownersRule {
    pattern: string;
    owners: string[];
    matcher: RegExp;
}

export function parseCodeowners(content: string): CodeownersRule[] {
    const rules: CodeownersRule[] = [];

    for (const raw of content.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        // GitLab section headers: [Name], ^[Name], [Name][2] @default-owner
        if (!line || /^\^?\[[^\]]+\]/.test(line)) {
            continue;
        }
        const [pattern, ...owners] = line.split(/\s+/);
        if (!pattern) {
            continue;
        }
        rules.push({
            pattern,
            owners: owners.filter((o) => o.startsWith('@') || o.includes('@')),
            matcher: toMatcher(pattern),
        });
    }

    return rules;
}

/** The owners of `filePath`, from the last rule that matches it. */
export function ownersFor(rules: CodeownersRule[], filePath: string): string[] {
    const path = filePath.replace(/^\.?\//, '');
    for (let i = rules.length - 1; i >= 0; i--) {
        if (rules[i].matcher.test(path)) {
            return rules[i].owners;
        }
    }
    return [];
}

function toMatcher(pattern: string): RegExp {
    let p = pattern;
    // A pattern with a slash anywhere but the end is relative to the root;
    // without one it matches at any depth, like gitignore.
    const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
    p = p.replace(/^\//, '');
    const directory = p.endsWith('/');
    p = p.replace(/\/$/, '');

    let body = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') {
                // `**/` = any number of directories; `**` alone = anything.
                if (p[i + 2] === '/') {
                    body += '(?:.*/)?';
                    i += 2;
                } else {
                    body += '.*';
                    i += 1;
                }
            } else {
                body += '[^/]*';
            }
        } else if (c === '?') {
            body += '[^/]';
        } else {
            body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }

    const prefix = anchored ? '^' : '^(?:.*/)?';
    // A directory pattern owns everything under it; a file-like pattern also
    // owns a directory of that name and its contents, except one whose last
    // segment has a single `*`: GitHub's `docs/*` owns docs/a.md, not
    // docs/a/b.md.
    const last = p.split('/').pop() ?? '';
    const shallow = last.includes('*') && !last.includes('**');
    const suffix = directory ? '/.*$' : shallow ? '$' : '(?:/.*)?$';
    return new RegExp(prefix + body + suffix);
}
