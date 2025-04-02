export const CODE_REVIEW_ANALYZER_TOKEN = Symbol('CodeReviewAnalyzer');

export interface CodeIssue {
    type:
        | 'complexity'
        | 'style'
        | 'security'
        | 'performance'
        | 'maintainability';
    severity: 'info' | 'warning' | 'error';
    message: string;
    line: number;
    column: number;
    suggestedFix?: string;
}

export interface FunctionMetrics {
    name: string;
    lineCount: number;
    parameterCount: number;
    cyclomaticComplexity: number;
    nestingDepth: number;
    returnCount: number;
}

export interface CodeMetrics {
    functions: FunctionMetrics[];
    totalLines: number;
    commentLines: number;
    duplicateCode: Array<{
        lines: number[];
        content: string;
    }>;
}

export interface ICodeReviewAnalyzer {
    /**
     * Analyzes the code for common issues
     * @param source Source code to analyze
     * @param language Code language
     * @returns List of found issues
     */
    findIssues(source: string, language: string): Promise<CodeIssue[]>;

    /**
     * Collects metrics about the code
     * @param source Source code to analyze
     * @param language Code language
     * @returns Code metrics
     */
    collectMetrics(source: string, language: string): Promise<CodeMetrics>;

    /**
     * Checks for overly complex functions
     * @param source Source code to analyze
     * @param language Code language
     * @param threshold Complexity threshold (default: 10)
     * @returns List of complex functions with their metrics
     */
    findComplexFunctions(
        source: string,
        language: string,
        threshold?: number,
    ): Promise<FunctionMetrics[]>;

    /**
     * Detects code patterns that may indicate issues
     * @param source Source code to analyze
     * @param language Code language
     * @returns List of found issues
     */
    detectAntiPatterns(source: string, language: string): Promise<CodeIssue[]>;

    /**
     * Checks for common security issues
     * @param source Source code to analyze
     * @param language Code language
     * @returns List of security issues
     */
    findSecurityIssues(source: string, language: string): Promise<CodeIssue[]>;
}
