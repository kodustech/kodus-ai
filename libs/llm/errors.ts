/**
 * Error emitted by kodus' agent pipeline (not the LLM provider) when a
 * preflight check determines the configured model cannot possibly handle
 * the review.
 *
 * The message intentionally includes the substring "context length" so
 * that classifyLLMError() (error-classifier.ts) maps them to
 * LlmErrorCategory.CONTEXT_OVERFLOW without needing a new category —
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
                `Choose a model with at least 32K context, or raise the model's max input tokens ` +
                `if the deployed model genuinely supports more than the default lookup reports.`,
        );
        this.name = 'AgentContextWindowTooSmallError';
        this.contextWindow = params.contextWindow;
        this.overheadTokens = params.overheadTokens;
        this.modelName = params.modelName;
    }
}
