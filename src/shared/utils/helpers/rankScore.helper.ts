import { SelectedCategories } from '@/config/types/general/selectedCategory.type';
import {
    MaintainabilitySeverityMatrix,
    CodeStyleSeverityMatrix,
    DocumentationAndCommentsSeverityMatrix,
    ErrorHandlingSeverityMatrix,
    PerformanceAndOptimizationSeverityMatrix,
    PotentialIssuesSeverityMatrix,
    RefactoringSeverityMatrix,
    SecuritySeverityMatrix,
    SeverityMatrix,
} from '@/config/types/general/severityMatrix.type';

export const validateSelectedCategories = (
    input: unknown,
): SelectedCategories => {
    const categories = input as SelectedCategories;

    if (!categories || typeof categories !== 'object') {
        throw new Error('Invalid categories object');
    }

    const validKeys = [
        'security',
        'code_style',
        'performance_and_optimization',
        'documentation_and_comments',
        'error_handling',
        'potential_issues',
        'maintainability',
        'refactoring',
        'kody_rules',
        'breaking_changes'
    ] as const;

    Object.keys(categories).forEach((key) => {
        if (!validKeys.includes(key as (typeof validKeys)[number])) {
            delete categories[key as keyof SelectedCategories];
        }
        if (typeof categories[key as keyof SelectedCategories] !== 'boolean') {
            categories[key as keyof SelectedCategories] = false;
        }
    });

    return categories;
};

export const generateSelectedMatrices = (
    selectedCategories: SelectedCategories,
): string => {
    try {
        const matrices: Record<string, SeverityMatrix> = {
            security: SecuritySeverityMatrix,
            performance_and_optimization:
                PerformanceAndOptimizationSeverityMatrix,
            error_handling: ErrorHandlingSeverityMatrix,
            maintainability: MaintainabilitySeverityMatrix,
            refactoring: RefactoringSeverityMatrix,
            potential_issues: PotentialIssuesSeverityMatrix,
            code_style: CodeStyleSeverityMatrix,
            documentation_and_comments: DocumentationAndCommentsSeverityMatrix,
        };

        return (
            Object.entries(selectedCategories)
                .filter(([_, value]) => value === true)
                .map(([category]) => {
                    try {
                        const normalizedCategory = normalizeCategory(category);
                        const matrix = matrices[normalizedCategory];

                        if (!matrix) return '';

                        return `<matrix category="${category}">
${Object.entries(matrix)
    .map(([level, data]) => {
        try {
            return `<${level}>
            <criteria>${data?.criteria?.join(', ') || 'No criteria available'}</criteria>
            </${level}>`;
        } catch {
            return `<${level}><criteria>Error processing criteria</criteria></${level}>`;
        }
    })
    .join('\n')}
</matrix>`;
                    } catch {
                        return '';
                    }
                })
                .filter(Boolean)
                .join('\n') ||
            '<matrix><error>No valid matrices generated</error></matrix>'
        );
    } catch {
        return '<matrix><error>Error generating severity matrices</error></matrix>';
    }
};

const categoryMapping: Record<string, string> = {
    security: 'security',
    code_style: 'code_style',
    performance_and_optimization: 'performance_and_optimization',
    documentation_and_comments: 'documentation_and_comments',
    error_handling: 'error_handling',
    potential_issues: 'potential_issues',
    maintainability: 'maintainability',
    refactoring: 'refactoring',
};

export const normalizeCategory = (category: string): string => {
    if (!category) return 'unknown';
    return categoryMapping[category.toLowerCase()] || category;
};
