/**
 * How the generalist finder runs for each model family (#1821): the step cap
 * of a finder pass and whether the synthesis-rescue pass runs after it. Each
 * family's row is the configuration that measured best for it; a model of no
 * listed family takes the default.
 *
 * The cap is per pass, not per PR: with the rescue on, the base pass and the
 * rescue pass each get up to `maxSteps`. `adaptive` keeps the budget the
 * orchestrator computed (review-orchestrator.service.ts getMaxStepsForAgent:
 * 20, plus 0.5 per changed file above 8, up to 100).
 *
 * The family is read from the model id alone, with bounded patterns so a
 * provider prefix (`us.anthropic.`, `accounts/fireworks/models/`,
 * `moonshotai/`) still matches and a different model whose id merely contains
 * the name (`gpt-oss`) does not. A deployment alias that names no family gets
 * the default.
 */
export type FinderStepBudget = number | 'adaptive';

export interface FinderModelProfile {
    family: string;
    maxSteps: FinderStepBudget;
    synthesisRescue: boolean;
}

// A family name starts the id or follows a provider prefix separator.
const START = String.raw`(?:^|[./:@_-])`;

const FAMILIES: ReadonlyArray<FinderModelProfile & { match: RegExp }> = [
    {
        family: 'claude-opus',
        match: new RegExp(`${START}claude-opus(?:$|[./:@_-])`, 'i'),
        maxSteps: 12,
        synthesisRescue: false,
    },
    {
        family: 'claude-sonnet',
        match: new RegExp(`${START}claude-sonnet(?:$|[./:@_-])`, 'i'),
        maxSteps: 12,
        synthesisRescue: true,
    },
    {
        family: 'gpt',
        match: new RegExp(`${START}gpt-(?!oss(?:$|[./:@_-]))\\d`, 'i'),
        maxSteps: 12,
        synthesisRescue: false,
    },
    {
        family: 'muse',
        match: new RegExp(`${START}muse-`, 'i'),
        maxSteps: 12,
        synthesisRescue: true,
    },
    {
        family: 'deepseek',
        match: new RegExp(`${START}deepseek-`, 'i'),
        maxSteps: 'adaptive',
        synthesisRescue: true,
    },
    {
        family: 'kimi',
        match: new RegExp(`${START}kimi-`, 'i'),
        maxSteps: 'adaptive',
        synthesisRescue: true,
    },
];

export const DEFAULT_FINDER_PROFILE: FinderModelProfile = {
    family: 'default',
    maxSteps: 12,
    synthesisRescue: false,
};

export function finderProfileFor(modelName?: string): FinderModelProfile {
    const id = (modelName ?? '').trim();
    const hit = id ? FAMILIES.find((f) => f.match.test(id)) : undefined;
    if (!hit) return DEFAULT_FINDER_PROFILE;
    const { match: _match, ...profile } = hit;
    return profile;
}

/**
 * The finder settings of a normal-mode review on `modelName`. Fast and deep
 * reviews keep the budget and rescue they were given; so does a caller that
 * already skipped the rescue.
 */
export function finderRunSettings(
    input: {
        reviewMode?: 'fast' | 'normal' | 'deep';
        maxSteps?: number;
        skipSynthesisRescue?: boolean;
    },
    modelName?: string,
): {
    profile: FinderModelProfile | undefined;
    maxSteps?: number;
    skipSynthesisRescue?: boolean;
} {
    if ((input.reviewMode ?? 'normal') !== 'normal') {
        return {
            profile: undefined,
            maxSteps: input.maxSteps,
            skipSynthesisRescue: input.skipSynthesisRescue,
        };
    }
    const profile = finderProfileFor(modelName);
    return {
        profile,
        maxSteps:
            profile.maxSteps === 'adaptive' ? input.maxSteps : profile.maxSteps,
        skipSynthesisRescue:
            !!input.skipSynthesisRescue || !profile.synthesisRescue,
    };
}
