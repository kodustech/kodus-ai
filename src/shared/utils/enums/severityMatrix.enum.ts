import {
    SeverityMatrix,
    SecuritySeverityMatrix,
    CodeStyleSeverityMatrix,
    RefactoringSeverityMatrix,
    ErrorHandlingSeverityMatrix,
    MaintainabilitySeverityMatrix,
    PotentialIssuesSeverityMatrix,
    DocumentationAndCommentsSeverityMatrix,
    PerformanceAndOptimizationSeverityMatrix,
} from '@/config/types/general/severityMatrix.type';

export enum SeverityMatrixType {
    SECURITY = 'security',
    CODE_STYLE = 'code_style',
    REFACTORING = 'refactoring',
    ERROR_HANDLING = 'error_handling',
    MAINTAINABILITY = 'maintainability',
    POTENTIAL_ISSUES = 'potential_issues',
    DOCUMENTATION = 'documentation_and_comments',
    PERFORMANCE = 'performance_and_optimization',
}

export const SeverityMatrices: Record<SeverityMatrixType, SeverityMatrix> = {
    [SeverityMatrixType.SECURITY]: SecuritySeverityMatrix,
    [SeverityMatrixType.CODE_STYLE]: CodeStyleSeverityMatrix,
    [SeverityMatrixType.REFACTORING]: RefactoringSeverityMatrix,
    [SeverityMatrixType.ERROR_HANDLING]: ErrorHandlingSeverityMatrix,
    [SeverityMatrixType.MAINTAINABILITY]: MaintainabilitySeverityMatrix,
    [SeverityMatrixType.POTENTIAL_ISSUES]: PotentialIssuesSeverityMatrix,
    [SeverityMatrixType.DOCUMENTATION]: DocumentationAndCommentsSeverityMatrix,
    [SeverityMatrixType.PERFORMANCE]: PerformanceAndOptimizationSeverityMatrix,
} as const;
