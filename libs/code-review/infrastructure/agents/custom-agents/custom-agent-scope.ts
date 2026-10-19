import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import {
    customAgentSlug,
    type CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

export { customAgentSlug };

/**
 * Custom review agents (#2172): which agents run on a review, and on which
 * of its files.
 */

/**
 * The changed files an agent reviews: those its `include` globs match (every
 * file when it lists none), minus those its `exclude` globs match.
 */
export function filesInAgentScope<T extends { filename: string }>(
    agent: Pick<CustomAgentConfig, 'scope'>,
    changedFiles: readonly T[],
): T[] {
    const { include, exclude } = agentGlobs(agent);
    const includeAll = withLiteralBrackets(include);
    const excludeAll = withLiteralBrackets(exclude);
    return changedFiles.filter(
        (file) =>
            (include.length === 0 ||
                isFileMatchingGlob(file.filename, includeAll)) &&
            !isFileMatchingGlob(file.filename, excludeAll),
    );
}

// The files the review's ignore paths set aside that an agent still reviews:
// those one of its include globs names explicitly (namesFilesExplicitly) and
// its excludes leave in. A team that ignores `package.json`, or a default
// such as `**/prod/**`, still meant an agent written for `package.json` or
// `infra/**/*.tf` to read it; a broad glob such as `**/*.ts` did not ask for
// the ignored files, so it does not get them. Callers pass only files that
// still exist: a deleted file is reviewed by no one.
export function ignoredFilesInAgentScope<T extends { filename: string }>(
    agent: Pick<CustomAgentConfig, 'scope'>,
    ignoredFiles: readonly T[],
): T[] {
    const explicit = withLiteralBrackets(
        agentGlobs(agent).include.filter(namesFilesExplicitly),
    );
    if (!explicit.length) {
        return [];
    }
    return filesInAgentScope(agent, ignoredFiles).filter((file) =>
        isFileMatchingGlob(file.filename, explicit),
    );
}

/** The ignored files that at least one of `agents` reviews by
 *  ignoredFilesInAgentScope; empty without agents. */
export function ignoredFilesNamedByAgents<T extends { filename: string }>(
    agents: ReadonlyArray<Pick<CustomAgentConfig, 'scope'>>,
    ignoredFiles: readonly T[],
): T[] {
    if (!agents.length || !ignoredFiles.length) {
        return [];
    }
    const named = new Set(
        agents.flatMap((agent) =>
            ignoredFilesInAgentScope(agent, ignoredFiles).map(
                (file) => file.filename,
            ),
        ),
    );
    return ignoredFiles.filter((file) => named.has(file.filename));
}

// Whether an include glob names its files rather than sweeping them up: it
// does when at least one of its path segments is literal, a directory or a
// file name with no glob syntax in it. `package.json`, `apps/web/package.json`,
// `**/Dockerfile`, `infra/**/*.tf` and `src/**` name files; `**`, `**/*`, `*`,
// `**/*.ts` and `*.{ts,tsx}` have no literal segment and do not, and neither
// does a segment that only starts literal (`Dockerfile.*`). `.` segments are
// not names.
export function namesFilesExplicitly(glob: string): boolean {
    return glob
        .trim()
        .split('/')
        .some(
            (segment) => segment && segment !== '.' && !hasGlobSyntax(segment),
        );
}

// `(` and `[` also open a literal Next.js route folder, `(shop)` or `[id]`;
// read as glob syntax they can only make a segment non-literal, so such a
// folder never names files on its own.
const hasGlobSyntax = (segment: string) => /[*?[\]{}()]/.test(segment);

/** An agent's include and exclude globs, trimmed, with a `!glob` written
 *  among the includes moved to the excludes. */
function agentGlobs(agent: Pick<CustomAgentConfig, 'scope'>): {
    include: string[];
    exclude: string[];
} {
    const globs = (list?: string[]) =>
        (list ?? []).map((g) => (g ?? '').trim()).filter(Boolean);
    // A `!glob` written among the includes is an exclusion: matched as a
    // pattern of its own it matches every other file and widens the scope.
    // `!(…)` is a negative extglob, an include pattern of its own.
    const isNegation = (g: string) => g.startsWith('!') && !g.startsWith('!(');
    const includeGlobs = globs(agent.scope?.include);
    return {
        include: includeGlobs.filter((g) => !isNegation(g)),
        exclude: [
            ...globs(agent.scope?.exclude),
            ...includeGlobs
                .filter(isNegation)
                .map((g) => g.slice(1))
                .filter(Boolean),
        ],
    };
}

/**
 * Each glob, plus its copy with `(`, `)`, `[` and `]` escaped. Those are glob
 * syntax, so a Next.js route folder written as is, `src/app/(shop)/[id]/**`,
 * matched no file; the escaped copy matches the path literally while the
 * original keeps its meaning as a glob.
 */
function withLiteralBrackets(patterns: string[]): string[] {
    return patterns.flatMap((p) => {
        const literal = p.replace(/[()[\]]/g, '\\$&');
        // A literal copy of a leading `!(…)` would read as a negation and
        // match nearly every file.
        return literal === p || p.startsWith('!') ? [p] : [p, literal];
    });
}

/**
 * The PR's call graph cut down to an agent's files: the changed functions and
 * imports of other files are removed, so a scoped agent is not pointed at code
 * outside its scope. The PR-wide summary goes with them, its counts no longer
 * holding. Empty when none of the agent's files is in the graph.
 */
export function scopeCallGraph(
    callGraph: string | undefined,
    paths: readonly string[],
): string | undefined {
    if (!callGraph) {
        return callGraph;
    }
    const inScope = new Set(paths);
    const fileOf = (tag: string, attr: string) =>
        tag.match(new RegExp(`\\b${attr}="([^"]*)"`))?.[1];
    let kept = 0;
    const scoped = callGraph
        .replace(
            /[ \t]*<ChangedFunction\b[^>]*>[\s\S]*?<\/ChangedFunction>[ \t]*\n?/g,
            (block) => {
                if (inScope.has(fileOf(block, 'file') ?? '')) {
                    kept++;
                    return block;
                }
                return '';
            },
        )
        .replace(/[ \t]*<Import\b[^>]*\/>[ \t]*\n?/g, (tag) =>
            inScope.has(fileOf(tag, 'source') ?? '') ||
            inScope.has(fileOf(tag, 'target') ?? '')
                ? tag
                : '',
        )
        .replace(/[ \t]*<Imports>\s*<\/Imports>[ \t]*\n?/g, '')
        .replace(/[ \t]*<Summary\b[^>]*\/>[ \t]*\n?/g, '')
        .replace(/\n{3,}/g, '\n\n');
    return kept > 0 ? scoped : '';
}

/**
 * The agents a review dispatches. A normal review runs every enabled one.
 * `@kody -v <slug>` asks for one agent by its slug; it runs
 * even while disabled, so a team can try an agent before turning it on.
 */
export function selectCustomAgents(
    agents: readonly CustomAgentConfig[] | undefined,
    onlySlug?: string,
): CustomAgentConfig[] {
    if (!agents?.length) {
        return [];
    }
    if (onlySlug) {
        const wanted = customAgentSlug(onlySlug);
        const match = agents.find((a) => customAgentSlug(a.name) === wanted);
        return match ? [match] : [];
    }
    // A save refuses two agents sharing a slug; a config saved before that
    // check runs the first, since run names and usage are keyed by slug.
    const seen = new Set<string>();
    return agents.filter((a) => {
        if (!a.enabled) return false;
        const slug = customAgentSlug(a.name);
        if (seen.has(slug)) return false;
        seen.add(slug);
        return true;
    });
}

/**
 * The reply to `@kody -v <slug>` when no configured agent answers to the
 * slug, listing the slugs that do; undefined when one does.
 */
export function unknownCustomAgentReply(
    agents: readonly Pick<CustomAgentConfig, 'name'>[] | undefined,
    onlySlug: string,
): string | undefined {
    const wanted = customAgentSlug(onlySlug);
    const slugs = [
        ...new Set((agents ?? []).map((a) => customAgentSlug(a.name))),
    ];
    if (slugs.includes(wanted)) {
        return undefined;
    }
    const known = slugs.length
        ? `Agents: ${slugs.map((slug) => `\`${slug}\``).join(', ')}.`
        : 'It has no custom agents.';
    return `No custom agent named \`${onlySlug}\` on this repository. ${known}`;
}

// The `@kody -v <slug>` parser lives with the other PR comment commands; the
// webhook handlers read it there.
export { parseCustomAgentCommand } from '@libs/common/utils/codeManagement/codeCommentMarkers';
