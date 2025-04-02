import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';

export interface SeverityMatrix {
    critical: SeverityMatrixItem;
    high: SeverityMatrixItem;
    medium: SeverityMatrixItem;
    low: SeverityMatrixItem;
}

export type SeverityMatrixItem = {
    title: string;
    description: string;
    criteria: string[];
};

export const SecuritySeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Security Issues',
        description:
            'Vulnerabilities that could lead to immediate system compromise',
        criteria: [
            'SQL injection vulnerabilities',
            'Cross-site scripting (XSS) risks',
            'Exposed sensitive data or credentials',
            'Authentication bypass possibilities',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Security Issues',
        description:
            'Significant security concerns requiring immediate attention',
        criteria: [
            'Missing authentication checks',
            'Inadequate input validation',
            'Insecure data transmission',
            'Missing authorization validations',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Security Issues',
        description:
            'Security improvements needed but not immediately critical',
        criteria: [
            'Insecure logging practices',
            'Deprecated security methods',
            'Missing security headers',
            'Weak password policies',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Security Issues',
        description: 'Minor security enhancements recommended',
        criteria: [
            'Security configuration improvements',
            'Minor CORS issues',
            'Security best practices suggestions',
            'Documentation of security measures',
        ],
    },
} as const;

export const PerformanceAndOptimizationSeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Performance Issues',
        description: 'Issues severely impacting system performance',
        criteria: [
            'Infinite loops or recursions',
            'Unoptimized queries affecting entire API',
            'Memory leaks',
            'Resource exhaustion risks',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Performance Issues',
        description: 'Significant performance bottlenecks',
        criteria: [
            'N+1 query problems',
            'Inefficient data structures',
            'Heavy computation in loops',
            'Unnecessary database calls',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Performance Issues',
        description: 'Performance optimizations recommended',
        criteria: [
            'Unoptimized route handlers',
            'Inefficient array operations',
            'Redundant computations',
            'Unoptimized async operations',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Performance Issues',
        description: 'Minor performance improvements possible',
        criteria: [
            'Small optimization opportunities',
            'Minor caching suggestions',
            'Code organization for performance',
            'Minimal impact optimizations',
        ],
    },
} as const;

export const ErrorHandlingSeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Error Handling Issues',
        description:
            'Missing or incorrect error handling in crucial operations',
        criteria: [
            'Unhandled errors in critical paths',
            'Missing transaction rollbacks',
            'System crash possibilities',
            'Data corruption risks',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Error Handling Issues',
        description: 'Important error handling improvements needed',
        criteria: [
            'Generic catch blocks',
            'Missing error recovery logic',
            'Incomplete error logging',
            'Incorrect error propagation',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Error Handling Issues',
        description: 'Error handling enhancements recommended',
        criteria: [
            'Inadequate error messages',
            'Inconsistent error handling patterns',
            'Missing error categorization',
            'Incomplete error documentation',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Error Handling Issues',
        description: 'Minor error handling improvements',
        criteria: [
            'Error message clarity',
            'Error logging format',
            'Error handling consistency',
            'Error documentation updates',
        ],
    },
} as const;

export const MaintainabilitySeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Maintainability Issues',
        description:
            'Severe maintainability problems requiring immediate attention',
        criteria: [
            'Highly coupled components',
            'Extreme code duplication',
            'Undocumented crucial logic',
            'Unmaintainable complexity',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Maintainability Issues',
        description: 'Significant maintainability concerns',
        criteria: [
            'SOLID principle violations',
            'Complex inheritance hierarchies',
            'Missing crucial documentation',
            'High cyclomatic complexity',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Maintainability Issues',
        description: 'Maintainability improvements recommended',
        criteria: [
            'Code organization issues',
            'Inconsistent patterns',
            'Moderate complexity',
            'Documentation gaps',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Maintainability Issues',
        description: 'Minor maintainability enhancements',
        criteria: [
            'Naming conventions',
            'File organization',
            'Comment quality',
            'Minor refactoring opportunities',
        ],
    },
} as const;

export const CodeStyleSeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Style Issues',
        description: 'Style violations blocking deployment',
        criteria: [
            'Build-breaking style issues',
            'Critical linting errors',
            'Deployment-blocking formatting',
            'Version control conflicts',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Style Issues',
        description: 'Major style guide violations',
        criteria: [
            'Significant style guide deviations',
            'Inconsistent code patterns',
            'Major formatting issues',
            'Breaking team conventions',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Style Issues',
        description: 'Style improvements needed',
        criteria: [
            'Minor style guide deviations',
            'Formatting inconsistencies',
            'Code pattern variations',
            'Documentation style issues',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Style Issues',
        description: 'Minor style enhancements',
        criteria: [
            'Spacing improvements',
            'Minor formatting suggestions',
            'Style consistency tweaks',
            'Documentation formatting',
        ],
    },
} as const;

export const DocumentationAndCommentsSeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Documentation Issues',
        description: 'Missing crucial documentation',
        criteria: [
            'Missing public API documentation',
            'Incorrect security documentation',
            'Missing deployment requirements',
            'Undocumented breaking changes',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Documentation Issues',
        description: 'Important documentation missing or incorrect',
        criteria: [
            'Outdated technical docs',
            'Missing interface documentation',
            'Incorrect example code',
            'Incomplete API references',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Documentation Issues',
        description: 'Documentation improvements needed',
        criteria: [
            'Incomplete documentation',
            'Unclear examples',
            'Missing edge cases',
            'Outdated diagrams',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Documentation Issues',
        description: 'Minor documentation enhancements',
        criteria: [
            'Documentation clarity',
            'Example improvements',
            'Format consistency',
            'Minor updates needed',
        ],
    },
} as const;

export const PotentialIssuesSeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Potential Issues',
        description: 'Severe potential problems requiring immediate attention',
        criteria: [
            'Memory leak risks',
            'Race condition possibilities',
            'Deadlock scenarios',
            'Data race vulnerabilities',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Potential Issues',
        description: 'Significant potential problems',
        criteria: [
            'Unhandled edge cases',
            'Potential null references',
            'Possible resource leaks',
            'Concurrent access issues',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Potential Issues',
        description: 'Moderate risk potential problems',
        criteria: [
            'Code smells',
            'Potential bottlenecks',
            'Future maintenance risks',
            'Scalability concerns',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Potential Issues',
        description: 'Minor potential problems',
        criteria: [
            'Minor edge cases',
            'Small improvement opportunities',
            'Low-risk code smells',
            'Minor defensive coding suggestions',
        ],
    },
} as const;

export const RefactoringSeverityMatrix: SeverityMatrix = {
    [SeverityLevel.CRITICAL]: {
        title: 'Critical Refactoring Issues',
        description: 'Legacy code causing immediate problems',
        criteria: [
            'Blocking legacy code',
            'Critical technical debt',
            'Deprecated dependency usage',
            'Unmaintainable architecture',
        ],
    },
    [SeverityLevel.HIGH]: {
        title: 'High Refactoring Issues',
        description: 'Significant refactoring needed',
        criteria: [
            'Major technical debt',
            'Complex legacy code',
            'Outdated patterns',
            'Significant duplication',
        ],
    },
    [SeverityLevel.MEDIUM]: {
        title: 'Medium Refactoring Issues',
        description: 'Moderate refactoring opportunities',
        criteria: [
            'Code structure improvements',
            'Pattern modernization',
            'Moderate duplication',
            'Component separation',
        ],
    },
    [SeverityLevel.LOW]: {
        title: 'Low Refactoring Issues',
        description: 'Minor refactoring suggestions',
        criteria: [
            'Small improvements',
            'Minor modernization',
            'Simple extract methods',
            'Basic cleanup',
        ],
    },
} as const;
