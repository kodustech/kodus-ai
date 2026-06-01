import labels from '@libs/automation/infrastructure/adapters/services/processAutomation/config/codeReview/labels.json';

export enum LabelType {
    PERFORMANCE_AND_OPTIMIZATION = 'performance_and_optimization',
    SECURITY = 'security',
    ERROR_HANDLING = 'error_handling',
    REFACTORING = 'refactoring',
    MAINTAINABILITY = 'maintainability',
    POTENTIAL_ISSUES = 'potential_issues',
    CODE_STYLE = 'code_style',
    DOCUMENTATION_AND_COMMENTS = 'documentation_and_comments',
    KODY_RULES = 'kody_rules',
    BREAKING_CHANGES = 'breaking_changes',
    BUG = 'bug',
    PERFORMANCE = 'performance',
    CROSS_FILE = 'cross_file',
    BUSINESS_LOGIC = 'business_logic',
}

enum ShieldColor {
    GREEN = '00C853',
    RED = 'D50000',
    ORANGE = 'FF6D00',
    BLUE = '304FFE',
    TEAL = '0091EA',
    DARK_RED = 'B71C1C',
    PURPLE = '6A1B9A',
    PINK = 'D81B60',
    INDIGO = '4527A0',
    YELLOW = 'FFD600',
    LIGHT_PURPLE = '9C27B0',
}

const getLabelShield = (label: string) => {
    const labelData: {
        type: string;
        name: string;
        description: string;
    } = labels.find((labelData) => labelData.type === label);
    if (!labelData) {
        return '';
    }

    const shield = `![${labelData?.name}](https://img.shields.io/badge/${labelData?.name?.replace(/ /g, '_')}-`;

    switch (labelData.type) {
        case LabelType.PERFORMANCE_AND_OPTIMIZATION:
            return `${shield}${ShieldColor.GREEN})`;
        case LabelType.SECURITY:
            return `${shield}${ShieldColor.RED})`;
        case LabelType.ERROR_HANDLING:
            return `${shield}${ShieldColor.ORANGE})`;
        case LabelType.REFACTORING:
            return `${shield}${ShieldColor.BLUE})`;
        case LabelType.MAINTAINABILITY:
            return `${shield}${ShieldColor.TEAL})`;
        case LabelType.POTENTIAL_ISSUES:
            return `${shield}${ShieldColor.DARK_RED})`;
        case LabelType.CODE_STYLE:
            return `${shield}${ShieldColor.PURPLE})`;
        case LabelType.DOCUMENTATION_AND_COMMENTS:
            return `${shield}${ShieldColor.PINK})`;
        case LabelType.KODY_RULES:
            return `${shield}${ShieldColor.INDIGO})`;
        case LabelType.BREAKING_CHANGES:
            return `${shield}${ShieldColor.YELLOW})`;
        case LabelType.BUG:
            return `${shield}${ShieldColor.DARK_RED})`;
        case LabelType.PERFORMANCE:
            return `${shield}${ShieldColor.ORANGE})`;
        case LabelType.CROSS_FILE:
            return `${shield}${ShieldColor.LIGHT_PURPLE})`;
        case LabelType.BUSINESS_LOGIC:
            return `${shield}${ShieldColor.TEAL})`;
        default:
            return '';
    }
};

export { getLabelShield };
