import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import {
    CUSTOM_AGENT_LIMITS,
    type CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Custom review agents (#2172): which agents run on a review, and on which
 * of its files.
 */

/** The agent's name as a command and run-name token: `Data Contracts` → `data-contracts`. */
export function customAgentSlug(name: string): string {
    const slug = (name || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'agent';
}

/**
 * The changed files an agent reviews: those its `include` globs match (every
 * file when it lists none), minus those its `exclude` globs match.
 */
export function filesInAgentScope<T extends { filename: string }>(
    agent: Pick<CustomAgentConfig, 'scope'>,
    changedFiles: readonly T[],
): T[] {
    const include = (agent.scope?.include ?? []).filter((g) => g?.trim());
    const exclude = (agent.scope?.exclude ?? []).filter((g) => g?.trim());
    return changedFiles.filter(
        (file) =>
            (include.length === 0 ||
                isFileMatchingGlob(file.filename, include)) &&
            !isFileMatchingGlob(file.filename, exclude),
    );
}

/**
 * The agents a review dispatches. A normal review runs the enabled ones, at
 * most `maxAgents`. `@kody -v <slug>` asks for one agent by its slug; it runs
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
    return agents
        .filter((a) => a.enabled)
        .slice(0, CUSTOM_AGENT_LIMITS.maxAgents);
}

// The `@kody -v <slug>` parser lives with the other PR comment commands; the
// webhook handlers read it there.
export { parseCustomAgentCommand } from '@libs/common/utils/codeManagement/codeCommentMarkers';
