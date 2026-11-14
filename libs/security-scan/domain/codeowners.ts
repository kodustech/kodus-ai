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
    matcher: { test(path: string): boolean };
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

/** Segment matching with a remembered star: no regular-expression backtracking. */
function matchesSegment(pattern: string, text: string): boolean {
    let p = 0,
        t = 0,
        star = -1,
        retry = 0;
    while (t < text.length) {
        if (pattern[p] === '?' || pattern[p] === text[t]) {
            p++;
            t++;
        } else if (pattern[p] === '*') {
            star = p++;
            retry = t;
        } else if (star >= 0) {
            p = star + 1;
            t = ++retry;
        } else return false;
    }
    while (pattern[p] === '*') p++;
    return p === pattern.length;
}

function toMatcher(pattern: string): CodeownersRule['matcher'] {
    let p = pattern.replace(/^\\#/, '#');
    const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
    const directory = p.endsWith('/');
    p = p.replace(/^\//, '').replace(/\/$/, '');
    const parts = p.split('/');
    const last = parts[parts.length - 1] ?? '';
    if (!anchored) parts.unshift('**');
    if (directory) parts.push('*', '**');
    else if (!last.includes('*') || last.includes('**')) parts.push('**');
    return {
        test(path) {
            const names = path.split('/');
            let previous = Array<boolean>(names.length + 1).fill(false);
            previous[0] = true;
            for (const part of parts) {
                const next = Array<boolean>(names.length + 1).fill(false);
                next[0] = part === '**' && previous[0];
                for (let i = 1; i <= names.length; i++) {
                    next[i] =
                        part === '**'
                            ? previous[i] || next[i - 1]
                            : previous[i - 1] &&
                              matchesSegment(part, names[i - 1]);
                }
                previous = next;
            }
            return previous[names.length];
        },
    };
}
