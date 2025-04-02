export const getSelectedLabels = (
    reviewOptions: Record<string, boolean>,
): string => {
    const labels = {
        security:
            'Suggestions that address potential vulnerabilities or improve the security of the code.',
        error_handling:
            'Suggestions to improve the way errors and exceptions are handled.',
        refactoring:
            'Suggestions to restructure the code for better readability, maintainability, or modularity.',
        performance_and_optimization:
            'Suggestions that directly impact the speed or efficiency of the code.',
        maintainability:
            'Suggestions that make the code easier to maintain and extend in the future.',
        potential_issues:
            'Suggestions that address possible bugs or logical errors in the code.',
        code_style:
            'Suggestions to improve the consistency and adherence to coding standards.',
        documentation_and_comments:
            'Suggestions related to improving code documentation.',
        kody_rules:
            'Suggestions that enforce the rules defined in the Kody configuration.',
        breaking_changes:
            'Suggestions that address breaking changes in the code.',
    } as const;

    return Object.entries(reviewOptions)
        .filter(
            ([key, value]) =>
                value === true &&
                Object.keys(labels).includes(key) &&
                key !== 'limitationType',
        )
        .map(([key]) => `- '${key}': ${labels[key as keyof typeof labels]}`)
        .join('\n');
};
