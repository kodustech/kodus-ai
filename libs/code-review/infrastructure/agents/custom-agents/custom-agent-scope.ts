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
    const globs = (list?: string[]) =>
        (list ?? []).map((g) => (g ?? '').trim()).filter(Boolean);
    // A `!glob` written among the includes is an exclusion: matched as a
    // pattern of its own it matches every other file and widens the scope.
    const includeGlobs = globs(agent.scope?.include);
    const include = includeGlobs.filter((g) => !g.startsWith('!'));
    const exclude = [
        ...globs(agent.scope?.exclude),
        ...includeGlobs
            .filter((g) => g.startsWith('!'))
            .map((g) => g.slice(1))
            .filter(Boolean),
    ];
    return changedFiles.filter(
        (file) =>
            (include.length === 0 ||
                isFileMatchingGlob(file.filename, include)) &&
            !isFileMatchingGlob(file.filename, exclude),
    );
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
