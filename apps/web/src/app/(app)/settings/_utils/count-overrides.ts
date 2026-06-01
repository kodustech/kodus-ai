import {
    FormattedConfigLevel,
    type FormattedCodeReviewConfig,
    type IFormattedConfigProperty,
} from "../code-review/_types";

const CODE_REVIEW_ROUTE_OVERRIDE_PATH_PREFIXES: Record<string, string[]> = {
    "general": [
        "ignorePaths",
        "baseBranches",
        "ignoredTitleKeywords",
        "automatedReviewActive",
        "showStatusFeedback",
        "reviewCadence",
        "pullRequestApprovalActive",
        "kodusConfigFileOverridesWebPreferences",
        "isRequestChangesActive",
        "runOnDraft",
        "enableCommittableSuggestions",
    ],
    "review-categories": ["reviewOptions"],
    "custom-prompts": ["v2PromptOverrides"],
    // The "Review Filters" tab lives under href=suggestion-control and
    // edits `suggestionControl.*` fields (max suggestions, severity
    // filter, grouping mode, etc.). The entry was dropped in
    // c4749d680 assuming the page would be removed along with the
    // sidebar rename, but the page is still there — without this entry
    // the override-count badge silently reads as 0.
    "suggestion-control": ["suggestionControl"],
    "pr-summary": ["summary"],
    "kody-rules": [
        // `ideRulesSyncEnabled` is intentionally NOT counted: it's an
        // import action toggle ("am I auto-syncing right now?"), not a
        // rule-shaping configuration. Counting it as an override made
        // the Kody Rules nav badge show "1" on repos that hadn't actually
        // customised any rule policy, which read as "1 custom rule" to
        // users.
        "llmGeneratedMemoriesRequireApproval",
        "kodyRulesGeneratorEnabled",
    ],
};

function matchesPathPrefix(path: string, prefixes?: string[]): boolean {
    if (!prefixes?.length) {
        return true;
    }

    return prefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}.`),
    );
}

function isFormattedConfigProperty(
    value: any,
): value is IFormattedConfigProperty<any> {
    return (
        value &&
        typeof value === "object" &&
        "value" in value &&
        "level" in value &&
        ("overriddenValue" in value || "overriddenLevel" in value)
    );
}

function countOverridesRecursive(
    obj: any,
    targetLevel: FormattedConfigLevel,
    pathPrefixes?: string[],
    path = "",
): number {
    if (!obj || typeof obj !== "object") {
        return 0;
    }

    if (isFormattedConfigProperty(obj)) {
        const propertyLevel = obj.level as FormattedConfigLevel;
        const overriddenLevel = obj.overriddenLevel as FormattedConfigLevel;

        const hasOverride =
            obj.overriddenValue !== undefined ||
            obj.overriddenLevel !== undefined;

        if (!hasOverride) {
            return 0;
        }

        const isGlobalOverridingDefault =
            propertyLevel === FormattedConfigLevel.GLOBAL &&
            overriddenLevel === FormattedConfigLevel.DEFAULT;

        if (isGlobalOverridingDefault) {
            return 0;
        }

        const isTargetLevel = propertyLevel === targetLevel;

        return isTargetLevel && matchesPathPrefix(path, pathPrefixes) ? 1 : 0;
    }

    let count = 0;
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            count += countOverridesRecursive(
                obj[key],
                targetLevel,
                pathPrefixes,
                path ? `${path}.${key}` : key,
            );
        }
    }

    return count;
}

export function countConfigOverrides(
    config: FormattedCodeReviewConfig,
    level: FormattedConfigLevel = FormattedConfigLevel.GLOBAL,
): number {
    return countOverridesRecursive(config, level);
}

export function countFormattedOverrides(
    config: unknown,
    level: FormattedConfigLevel = FormattedConfigLevel.GLOBAL,
): number {
    return countOverridesRecursive(config, level);
}

export function countConfigOverridesByRoute(
    config: FormattedCodeReviewConfig | undefined,
    routeHref: string,
    level: FormattedConfigLevel = FormattedConfigLevel.GLOBAL,
): number | null {
    if (!config) {
        return null;
    }

    const pathPrefixes = CODE_REVIEW_ROUTE_OVERRIDE_PATH_PREFIXES[routeHref];

    if (!pathPrefixes) {
        return null;
    }

    return countOverridesRecursive(config, level, pathPrefixes);
}

export function countConfigOverridesForRoutes(
    config: FormattedCodeReviewConfig | undefined,
    routeHrefs: string[],
    level: FormattedConfigLevel = FormattedConfigLevel.GLOBAL,
): number {
    if (!config) {
        return 0;
    }

    const uniquePathPrefixes = Array.from(
        new Set(
            routeHrefs.flatMap(
                (routeHref) =>
                    CODE_REVIEW_ROUTE_OVERRIDE_PATH_PREFIXES[routeHref] ?? [],
            ),
        ),
    );

    if (!uniquePathPrefixes.length) {
        return 0;
    }

    return countOverridesRecursive(config, level, uniquePathPrefixes);
}
