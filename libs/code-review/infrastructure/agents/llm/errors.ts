/**
 * Errors emitted by kodus' agent pipeline (not the LLM provider) when a
 * preflight check determines the configured model cannot possibly handle
 * the review.
 *
 * Both messages intentionally include the substring "context length" so
 * that classifyLLMError() (error-classifier.ts) maps them to
 * ReviewErrorCategory.CONTEXT_OVERFLOW without needing a new category —
 * the existing message-substring matcher already covers this case for
 * provider-emitted errors.
 */

export interface AgentContextWindowTooSmallErrorParams {
    contextWindow: number;
    overheadTokens: number;
    modelName: string;
}

/**
 * Thrown when the agent's static prompt overhead (system prompt + tool
 * schemas + coverage list) by itself exceeds the model's context window.
 * In this state, no PR can ever fit — the user must pick a larger model.
 */
export class AgentContextWindowTooSmallError extends Error {
    readonly contextWindow: number;
    readonly overheadTokens: number;
    readonly modelName: string;

    constructor(params: AgentContextWindowTooSmallErrorParams) {
        super(
            `Model '${params.modelName}' has a context length of ${params.contextWindow} tokens, ` +
                `but the agent's static overhead alone is ${params.overheadTokens} tokens. ` +
                `Choose a model with at least 32K context, or raise byokConfig.main.maxInputTokens ` +
                `if the deployed model genuinely supports more than the default lookup reports.`,
        );
        this.name = 'AgentContextWindowTooSmallError';
        this.contextWindow = params.contextWindow;
        this.overheadTokens = params.overheadTokens;
        this.modelName = params.modelName;
    }
}

export interface AgentPromptTooLargeErrorParams {
    estimatedTokens: number;
    contextWindowTokens: number;
    modelName: string;
}

/**
 * Thrown by the agent loop's preflight when the assembled prompt
 * (systemPrompt + userPrompt + reserved output budget) exceeds the
 * model's context window. Distinct from the overhead-only check because
 * a model may have enough room for the overhead but not enough for the
 * specific PR's diffs.
 */
export class AgentPromptTooLargeError extends Error {
    readonly estimatedTokens: number;
    readonly contextWindowTokens: number;
    readonly modelName: string;

    constructor(params: AgentPromptTooLargeErrorParams) {
        super(
            `Estimated prompt of ${params.estimatedTokens} tokens exceeds maximum context length ` +
                `of ${params.contextWindowTokens} tokens for model '${params.modelName}'. ` +
                `Either reduce the PR size or switch to a model with a larger context window.`,
        );
        this.name = 'AgentPromptTooLargeError';
        this.estimatedTokens = params.estimatedTokens;
        this.contextWindowTokens = params.contextWindowTokens;
        this.modelName = params.modelName;
    }
}
