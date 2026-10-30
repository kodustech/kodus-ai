/**
 * The Business Logic settings a team edits on its settings page. Stored
 * under `businessLogic` in the code review config, so a repository or a
 * directory can override any of them (UC-02). Every field is optional and
 * the defaults keep today's behavior: no setup needed (UC-44).
 */
import { isRegexSafe } from '@libs/common/utils/safe-regex';
import type { BusinessLogicConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export type { BusinessLogicConfig };

export type CriteriaLocation = NonNullable<
    BusinessLogicConfig['criteriaLocation']
>;

export type RecheckOn = NonNullable<BusinessLogicConfig['recheckOn']>;

const RECHECK_ON: readonly RecheckOn[] = ['failing', 'push', 'request'];

/** `auto`: every connected tracker, in connection order. */
export const AUTO_TASK_SOURCE = 'auto';

export const MAX_TEAM_GUIDANCE = 2000;

export interface BusinessLogicSettings {
    taskSource: string;
    taskSourceTool?: string;
    /** A regex for task ids the built-in shapes miss; only ever a safe one. */
    taskIdPattern?: string;
    criteria:
        | { location: 'auto' }
        | { location: 'heading'; heading: string }
        | { location: 'field'; field: string };
    teamGuidance?: string;
    commentWhenMet: boolean;
    recheckOn: RecheckOn;
    requireTask: boolean;
}

export const DEFAULT_BUSINESS_LOGIC_SETTINGS: BusinessLogicSettings = {
    taskSource: AUTO_TASK_SOURCE,
    criteria: { location: 'auto' },
    commentWhenMet: true,
    // #1812: the automatic check runs once per PR; after that only on the
    // command or `--force`, unless the team asks for more.
    recheckOn: 'request',
    requireTask: false,
};

export function resolveBusinessLogicSettings(
    config: BusinessLogicConfig | undefined,
): BusinessLogicSettings {
    if (!config) {
        return DEFAULT_BUSINESS_LOGIC_SETTINGS;
    }
    const heading = config.criteriaHeading?.trim();
    const field = config.criteriaField?.trim();
    const criteria: BusinessLogicSettings['criteria'] =
        config.criteriaLocation === 'heading' && heading
            ? { location: 'heading', heading }
            : config.criteriaLocation === 'field' && field
              ? { location: 'field', field }
              : { location: 'auto' };
    const guidance = config.teamGuidance?.trim().slice(0, MAX_TEAM_GUIDANCE);

    return {
        taskSource: config.taskSource?.trim() || AUTO_TASK_SOURCE,
        taskSourceTool: config.taskSourceTool?.trim() || undefined,
        taskIdPattern: usablePattern(config.taskIdPattern),
        criteria,
        ...(guidance ? { teamGuidance: guidance } : {}),
        commentWhenMet: config.commentWhenMet !== false,
        recheckOn: RECHECK_ON.includes(config.recheckOn as RecheckOn)
            ? (config.recheckOn as RecheckOn)
            : DEFAULT_BUSINESS_LOGIC_SETTINGS.recheckOn,
        requireTask: config.requireTask === true,
    };
}

/** The pattern, when it compiles and can't hang a review on a crafted title. */
function usablePattern(pattern: string | undefined): string | undefined {
    const trimmed = pattern?.trim();
    if (!trimmed || !isRegexSafe(trimmed)) {
        return undefined;
    }
    try {
        new RegExp(trimmed);
        return trimmed;
    } catch {
        return undefined;
    }
}
