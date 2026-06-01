import { LLMAdapter, AgentInputEnum } from '../../core/types/allTypes.js';
import { createLogger, getObservability } from '../../observability/index.js';
import { BaseExecutionStrategy } from './strategy-interface.js';
import { SharedStrategyMethods } from './shared-methods.js';
import type {
    StrategyExecutionContext,
    ExecutionResult,
    ExecutionStep,
    AgentAction,
    ActionResult,
    AgentThought,
    ResultAnalysis,
} from './types.js';
import { StrategyPromptFactory } from './prompts/index.js';
import { ContextService } from '../../core/contextNew/index.js';
import { EnhancedJSONParser } from '../../utils/json-parser.js';
import { isEnhancedError } from '../../core/error-unified.js';

export class ReActStrategy extends BaseExecutionStrategy {
    private readonly logger = createLogger('react-strategy');
    private readonly promptFactory: StrategyPromptFactory;

    private readonly config: {
        maxIterations: number;
        maxToolCalls: number;
        maxExecutionTime: number;
        stepTimeout: number;
    };
    private readonly llmDefaults?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        maxReasoningTokens?: number;
        stop?: string[];
    };

    constructor(
        private llmAdapter: LLMAdapter,
        options: Partial<{
            llmAdapter: LLMAdapter;
            maxIterations: number;
            maxToolCalls: number;
            maxExecutionTime: number;
            stepTimeout: number;
        }> = {},
    ) {
        super();

        const defaultConfig = {
            maxIterations: 10,
            maxToolCalls: 20,
            maxExecutionTime: 300000,
            stepTimeout: 60000,
        };

        this.promptFactory = new StrategyPromptFactory();
        this.config = { ...defaultConfig, ...options } as any;
        this.llmDefaults = (options as any)?.llmDefaults;
    }

    async execute(context: StrategyExecutionContext): Promise<ExecutionResult> {
        const startTime = Date.now();
        const steps: ExecutionStep[] = [];
        let iteration = 0;
        let toolCallsCount = 0;
        const enableScratchpad = context.config.scratchpad?.enabled ?? false;
        let currentScratchpad: string | undefined = enableScratchpad
            ? context.scratchpad
            : undefined;

        const threadId = context.agentContext.thread?.id;
        if (!threadId) {
            throw new Error('ThreadId required for ContextService operations');
        }

        return await getObservability().traceAgent(
            'react-strategy',
            async () => {
                try {
                    this.validateContext(context);

                    const actionHistory: string[] = [];

                    while (iteration < this.config.maxIterations) {
                        context.scratchpad = currentScratchpad;

                        const isLastIteration =
                            iteration === this.config.maxIterations - 1;
                        const hasFinalAnswer = steps.some(
                            (step) => step.action?.type === 'final_answer',
                        );

                        if (isLastIteration && !hasFinalAnswer) {
                            const finalStep = await this.forceFinalAnswer(
                                context,
                                iteration,
                                steps,
                                'Maximum iterations reached without final answer',
                            );
                            steps.push(finalStep);
                            break;
                        }

                        if (
                            this.shouldStop(
                                iteration,
                                toolCallsCount,
                                startTime,
                                steps,
                            )
                        ) {
                            break;
                        }

                        const potentialLoop = this.detectLoop(
                            steps,
                            actionHistory,
                        );
                        if (potentialLoop && iteration > 2) {
                            this.logger.warn({
                                message:
                                    'Potential loop detected, forcing final answer',
                                context: this.constructor.name,

                                metadata: {
                                    repeatedAction: potentialLoop,
                                    iteration,
                                },
                            });
                            const finalStep = await this.forceFinalAnswer(
                                context,
                                iteration,
                                steps,
                                `Detected repeated action: ${potentialLoop}. Preventing infinite loop.`,
                            );
                            steps.push(finalStep);
                            break;
                        }

                        const step = await this.executeIteration(
                            context,
                            iteration,
                            steps,
                        );
                        steps.push(step);

                        // Update scratchpad from thought if available AND enabled
                        if (
                            enableScratchpad &&
                            step.thought?.scratchpadUpdate
                        ) {
                            currentScratchpad = step.thought.scratchpadUpdate;
                            this.logger.debug({
                                message: 'Scratchpad updated',
                                context: this.constructor.name,

                                metadata: {
                                    length: currentScratchpad.length,
                                    iteration,
                                },
                            });
                        }

                        if (
                            step.action?.type === 'tool_call' &&
                            step.action.toolName
                        ) {
                            actionHistory.push(
                                `${step.action.type}:${step.action.toolName}`,
                            );
                        } else if (step.action?.type) {
                            actionHistory.push(step.action.type);
                        }

                        if (step.action?.type === 'final_answer') {
                            this.logger.debug({
                                message:
                                    'Final answer reached, stopping execution',
                                context: this.constructor.name,

                                metadata: {
                                    iteration: iteration + 1,
                                    totalSteps: steps.length,
                                },
                            });
                            break;
                        }

                        if (step.action?.type === 'tool_call') {
                            toolCallsCount++;
                        }

                        iteration++;
                    }

                    const result = this.buildSuccessResult(
                        steps,
                        startTime,
                        iteration,
                        toolCallsCount,
                    );

                    return result;
                } catch (error) {
                    const result = this.buildErrorResult(
                        error,
                        steps,
                        startTime,
                        iteration,
                        toolCallsCount,
                    );

                    this.logger.error({
                        message: `ReAct strategy completed with error: ${result.error}`,
                        context: this.constructor.name,
                    });

                    return result;
                }
            },
            {
                correlationId: context.agentContext.correlationId,
                tenantId: context.agentContext.tenantId,
                sessionId: context.agentContext.sessionId,
                input: context.input,
            },
        );
    }

    private validateContext(context: StrategyExecutionContext): void {
        if (!context.input?.trim()) {
            throw new Error('Input cannot be empty');
        }

        if (!Array.isArray(context.agentContext?.availableTools)) {
            throw new Error('Tools must be an array');
        }

        if (!context.agentContext) {
            throw new Error('Agent context is required');
        }

        if (context.input.length > 10000) {
            this.logger.warn({
                message: 'Input is very long, may affect performance',
                context: this.constructor.name,

                metadata: {
                    inputLength: context.input.length,
                },
            });
        }

        if (context.agentContext?.availableTools.length === 0) {
            this.logger.warn({
                message:
                    'No tools provided - React strategy may not be able to perform complex actions',
                context: this.constructor.name,
            });
        }

        if (context.agentContext?.availableTools.length > 50) {
            this.logger.warn({
                message:
                    'Many tools provided - may impact prompt size and performance',
                context: this.constructor.name,

                metadata: {
                    toolsCount: context.agentContext?.availableTools.length,
                },
            });
        }

        this.logger.debug({
            message: 'Context validation passed',
            context: this.constructor.name,

            metadata: {
                inputLength: context.input.length,
                toolsCount: context.agentContext?.availableTools?.length || 0,
                hasAgentContext: !!context.agentContext,
            },
        });
    }

    private async executeIteration(
        context: StrategyExecutionContext,
        iteration: number,
        previousSteps: ExecutionStep[],
    ): Promise<ExecutionStep> {
        const stepStartTime = Date.now();

        try {
            const threadId = context.agentContext.thread?.id;

            this.logger.debug({
                message: 'Starting iteration execution',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration,
                    previousStepsCount: previousSteps.length,
                    hasLLMAdapter: !!this.llmAdapter,
                },
            });

            if (!this.llmAdapter) {
                throw new Error(
                    'LLM adapter not available for iteration execution',
                );
            }

            let thought: AgentThought;
            try {
                thought = await this.generateThought(
                    context,
                    iteration,
                    previousSteps,
                );

                this.logger.debug({
                    message: 'Thought generated',
                    context: this.constructor.name,

                    metadata: {
                        threadId,
                        iteration,
                        actionType: thought.action.type,
                        hasReasoning: !!thought.reasoning,
                    },
                });
            } catch (thoughtError) {
                this.logger.error({
                    message: 'Thought generation failed in iteration',
                    context: this.constructor.name,
                    error:
                        thoughtError instanceof Error
                            ? thoughtError
                            : undefined,

                    metadata: {
                        iteration,
                        threadId,
                    },
                });

                thought = {
                    reasoning: `Thought generation failed: ${thoughtError instanceof Error ? thoughtError.message : String(thoughtError)}`,
                    confidence: 0.0,
                    hypotheses: [],
                    reflection: {
                        shouldContinue: false,
                        reasoning: 'Thought generation failed',
                        alternatives: [],
                    },
                    earlyStopping: {
                        shouldStop: true,
                        reason: 'Thought generation error',
                    },
                    action: {
                        type: 'final_answer',
                        content: `I encountered an error while processing your request: ${thoughtError instanceof Error ? thoughtError.message : String(thoughtError)}`,
                    },
                    metadata: {
                        iteration,
                        timestamp: Date.now(),
                        error: true,
                    },
                };
            }

            const actionResult = await this.executeAction(
                thought.action,
                context,
            );

            this.logger.debug({
                message: 'Action executed',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration,
                    actionType: thought.action.type,
                    resultType: actionResult.type,
                    hasContent: !!actionResult.content,
                },
            });

            const observation = await this.analyzeResult(actionResult);

            this.logger.debug({
                message: 'Result analyzed',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration,
                    isComplete: observation.isComplete,
                    shouldContinue: observation.shouldContinue,
                    isSuccessful: observation.isSuccessful,
                },
            });

            if (threadId) {
                try {
                    await this.updateSessionMinimal(threadId, {
                        iteration: iteration + 1,
                        actionType: thought.action.type,
                        isCompleted: observation.isComplete,
                        stepId: `react-step-${iteration}`,
                        toolName:
                            thought.action.type === 'tool_call'
                                ? thought.action.toolName
                                : undefined,
                    });
                } catch (error) {
                    this.logger.debug({
                        message: 'Session update failed (non-critical)',
                        context: this.constructor.name,
                        error: error as Error,
                    });
                }
            }

            this.logger.debug({
                message: 'Observe step completed',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration,
                    isComplete: observation.isComplete,
                    shouldContinue: observation.shouldContinue,
                },
            });

            const step: ExecutionStep = {
                id: `react-step-${iteration}-${Date.now()}`,
                type: 'think',
                type2: 'think' as any,
                status: 'completed',
                timestamp: stepStartTime,
                duration: Date.now() - stepStartTime,
                thought,
                action: thought.action,
                result: actionResult,
                observation,
                metadata: {
                    iteration,
                    strategy: 'react',
                    stepSequence: 'think-act-observe',
                    completedAt: Date.now(),
                },
            };

            this.logger.debug({
                message: 'Step completed successfully',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration,
                    stepId: step.id,
                    actionType: thought.action.type,
                    resultType: actionResult.type,
                },
            });

            return step;
        } catch (error) {
            this.logger.error({
                message: `Iteration ${iteration + 1} failed`,
                context: this.constructor.name,
                error: error instanceof Error ? error : undefined,

                metadata: {
                    iteration,
                },
            });

            const errorThought: AgentThought = {
                reasoning: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
                confidence: 0.0,
                hypotheses: [],
                reflection: {
                    shouldContinue: false,
                    reasoning: 'Unexpected error occurred',
                    alternatives: [],
                },
                earlyStopping: {
                    shouldStop: true,
                    reason: 'Unexpected error',
                },
                action: {
                    type: 'final_answer',
                    content: `An unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`,
                },
                metadata: {
                    iteration,
                    timestamp: Date.now(),
                    error: true,
                },
            };

            const errorAction: AgentAction = {
                type: 'final_answer',
                content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            };

            const errorResult: ActionResult = {
                type: 'error',
                success: false,
                content: error instanceof Error ? error.message : String(error),
                metadata: {
                    timestamp: Date.now(),
                    source: 'react-strategy',
                    executionTime: Date.now() - stepStartTime,
                    error: true,
                },
            };

            return {
                id: `react-step-error-${iteration}-${Date.now()}`,
                type: 'think',
                type2: 'think' as any,
                status: 'failed',
                timestamp: stepStartTime,
                duration: Date.now() - stepStartTime,
                thought: errorThought,
                action: errorAction,
                result: errorResult,
                observation: await this.analyzeResult(errorResult),
                metadata: {
                    iteration,
                    strategy: 'react',
                    error:
                        error instanceof Error ? error.message : String(error),
                    errorStack:
                        error instanceof Error ? error.stack : undefined,
                    failedAt: Date.now(),
                    originalThought: false,
                    originalAction: false,
                },
            };
        }
    }

    private async generateThought(
        context: StrategyExecutionContext,
        iteration: number,
        previousSteps: ExecutionStep[],
    ): Promise<AgentThought> {
        const thoughtStartTime = Date.now();

        try {
            this.logger.debug({
                message: 'Starting thought generation',
                context: this.constructor.name,

                metadata: {
                    iteration,
                    previousStepsCount: previousSteps.length,
                    hasLLMAdapter: !!this.llmAdapter?.call,
                },
            });

            if (!this.llmAdapter?.call) {
                throw new Error('LLM adapter must support call method');
            }

            context.mode = 'executor';
            context.step = previousSteps[previousSteps.length - 1];

            context.history = previousSteps.map((step, index) => {
                this.logger.debug({
                    message: 'Processing step for history',
                    context: this.constructor.name,

                    metadata: {
                        stepIndex: index,
                        stepId: step.id,
                        stepType: step.type,
                        hasThought: !!step.thought,
                        hasAction: !!step.action,
                        hasResult: !!step.result,
                        thoughtReasoning: step.thought?.reasoning,
                        actionType: step.action?.type,
                        resultType: step.result?.type,
                    },
                });

                return {
                    type: step.type || 'unknown',
                    thought: step.thought
                        ? {
                              reasoning: step.thought.reasoning,
                              action: step.action,
                          }
                        : undefined,
                    action: step.action,
                    result: step.result
                        ? {
                              type: step.result.type,
                              content: step.result.content,
                              success: step.result.type !== 'error',
                          }
                        : undefined,
                };
            }) as ExecutionStep[];

            context.currentIteration = iteration;
            context.maxIterations = this.config.maxIterations;

            this.logger.debug({
                message: 'Context prepared for LLM',
                context: this.constructor.name,

                metadata: {
                    iteration,
                    historyLength: context.history.length,
                    hasCollectedInfo: !!context.collectedInfo,
                    currentIteration: context.currentIteration,
                    maxIterations: context.maxIterations,
                },
            });

            const prompts = this.promptFactory.createReActPrompt(context);

            this.logger.debug({
                message: 'Calling LLM',
                context: this.constructor.name,

                metadata: {
                    iteration,
                    systemPromptLength: prompts.systemPrompt.length,
                    userPromptLength: prompts.userPrompt.length,
                },
            });

            let response;
            try {
                response = await this.llmAdapter.call({
                    messages: [
                        {
                            role: AgentInputEnum.SYSTEM,
                            content: prompts.systemPrompt,
                        },
                        {
                            role: AgentInputEnum.USER,
                            content: prompts.userPrompt,
                        },
                    ],
                    model: this.llmDefaults?.model,
                    temperature: this.llmDefaults?.temperature,
                    maxTokens: this.llmDefaults?.maxTokens,
                    maxReasoningTokens: this.llmDefaults?.maxReasoningTokens,
                    stop: this.llmDefaults?.stop,
                    signal: context.agentContext?.signal,
                });

                this.logger.debug({
                    message: 'LLM call successful',
                    context: this.constructor.name,

                    metadata: {
                        iteration,
                        hasResponse: !!response,
                        responseType: typeof response,
                        hasContent: !!response?.content,
                    },
                });
            } catch (llmError) {
                const errorMessage =
                    llmError instanceof Error
                        ? llmError.message
                        : String(llmError);

                this.logger.error({
                    message: 'LLM call failed',
                    context: this.constructor.name,
                    error: llmError instanceof Error ? llmError : undefined,

                    metadata: {
                        iteration,
                    },
                });

                return {
                    reasoning: `LLM encountered an error: ${errorMessage}`,
                    confidence: 0.0,
                    hypotheses: [
                        {
                            approach: 'Error fallback',
                            confidence: 0.0,
                            action: {
                                type: 'final_answer',
                                content: `I encountered an error while processing your request: ${errorMessage}. Please try rephrasing your question.`,
                            },
                        },
                    ],
                    reflection: {
                        shouldContinue: false,
                        reasoning: 'LLM error occurred, cannot proceed safely',
                        alternatives: [],
                    },
                    earlyStopping: {
                        shouldStop: true,
                        reason: 'LLM error prevents safe execution',
                    },
                    action: {
                        type: 'final_answer',
                        content: `I encountered an error while processing your request: ${errorMessage}. Please try rephrasing your question.`,
                    },
                    metadata: {
                        iteration,
                        timestamp: Date.now(),
                        fallbackUsed: true,
                        errorReason: 'llm_error',
                        thoughtGenerationTime: Date.now() - thoughtStartTime,
                    },
                };
            }

            let content: string;
            if (typeof response.content === 'string') {
                content = response.content;
            } else if (response.content) {
                content = JSON.stringify(response.content);
            } else {
                throw new Error('LLM returned empty or invalid response');
            }

            this.logger.debug({
                message: 'LLM response content extracted',
                context: this.constructor.name,

                metadata: {
                    iteration,
                    contentLength: content.length,
                    contentPreview: content.substring(0, 200),
                },
            });

            const thought = await this.parseLLMResponse(content, iteration);

            this.logger.debug({
                message: 'Thought successfully generated',
                context: this.constructor.name,

                metadata: {
                    iteration,
                    actionType: thought.action.type,
                    hasReasoning: !!thought.reasoning,
                    thoughtGenerationTime: Date.now() - thoughtStartTime,
                },
            });

            return thought;
        } catch (error) {
            this.logger.error({
                message: 'Thought generation failed',
                context: this.constructor.name,
                error: error instanceof Error ? error : undefined,

                metadata: {
                    iteration,
                    thoughtGenerationTime: Date.now() - thoughtStartTime,
                },
            });

            return {
                reasoning: `Thought generation failed: ${error instanceof Error ? error.message : String(error)}`,
                confidence: 0.0,
                hypotheses: [
                    {
                        approach: 'Error fallback',
                        confidence: 0.0,
                        action: {
                            type: 'final_answer',
                            content: `I encountered an error while processing your request. Please try rephrasing your question.`,
                        },
                    },
                ],
                reflection: {
                    shouldContinue: false,
                    reasoning:
                        'Thought generation failed, cannot proceed safely',
                    alternatives: [],
                },
                earlyStopping: {
                    shouldStop: true,
                    reason: 'Thought generation error prevents safe execution',
                },
                action: {
                    type: 'final_answer',
                    content: `I encountered an error while processing your request. Please try rephrasing your question.`,
                },
                metadata: {
                    iteration,
                    timestamp: Date.now(),
                    fallbackUsed: true,
                    errorReason: 'thought_generation_error',
                    thoughtGenerationTime: Date.now() - thoughtStartTime,
                },
            };
        }
    }

    private async executeAction(
        action: AgentAction,
        context: StrategyExecutionContext,
    ): Promise<ActionResult> {
        const actionStartTime = Date.now();

        try {
            this.logger.debug({
                message: 'Starting action execution',
                context: this.constructor.name,

                metadata: {
                    actionType: action.type,
                    threadId: context.agentContext.thread?.id,
                },
            });

            switch (action.type) {
                case 'tool_call':
                    this.logger.debug({
                        message: 'Executing tool call',
                        context: this.constructor.name,

                        metadata: {
                            toolName: action.toolName,
                            hasInput: !!action.input,
                            inputType: typeof action.input,
                            threadId: context.agentContext.thread?.id,
                        },
                    });

                    try {
                        const result = await SharedStrategyMethods.executeTool(
                            action,
                            context,
                        );

                        this.logger.debug({
                            message: 'Tool executed successfully',
                            context: this.constructor.name,

                            metadata: {
                                toolName: action.toolName,
                                hasResult: !!result,
                                resultType: typeof result,
                                executionTime: Date.now() - actionStartTime,
                                threadId: context.agentContext.thread?.id,
                            },
                        });

                        try {
                            const threadId = context.agentContext.thread?.id;
                            if (threadId) {
                                await ContextService.updateExecution(threadId, {
                                    stepsJournalAppend: {
                                        stepId: `react-tool-${Date.now()}`,
                                        type: 'tool_call',
                                        toolName: action.toolName,
                                        status: 'completed',
                                        endedAt: Date.now(),
                                        startedAt: actionStartTime,
                                        durationMs:
                                            Date.now() - actionStartTime,
                                    },
                                    correlationId:
                                        getObservability().getContext()
                                            ?.correlationId,
                                });
                            }
                        } catch {}

                        return {
                            type: 'tool_result',
                            content: result,
                            success: !!result,
                            metadata: {
                                toolName: action.toolName,
                                arguments: action.input,
                                timestamp: Date.now(),
                                source: 'react-strategy',
                                executionTime: Date.now() - actionStartTime,
                            },
                        };
                    } catch (toolError) {
                        this.logger.error({
                            message: 'Tool execution failed',
                            context: this.constructor.name,
                            error:
                                toolError instanceof Error
                                    ? toolError
                                    : undefined,

                            metadata: {
                                toolName: action.toolName,
                                executionTime: Date.now() - actionStartTime,
                                threadId: context.agentContext.thread?.id,
                            },
                        });

                        try {
                            const threadId = context.agentContext.thread?.id;
                            if (threadId) {
                                const subcode = isEnhancedError(
                                    toolError as any,
                                )
                                    ? (toolError as any).context?.subcode
                                    : undefined;
                                await ContextService.updateExecution(threadId, {
                                    status: 'error',
                                    stepsJournalAppend: {
                                        stepId: `react-tool-${Date.now()}`,
                                        type: 'tool_call',
                                        toolName: action.toolName,
                                        status: 'failed',
                                        endedAt: Date.now(),
                                        errorSubcode:
                                            subcode ||
                                            (toolError instanceof Error
                                                ? toolError.name
                                                : 'Error'),
                                    },
                                    correlationId:
                                        getObservability().getContext()
                                            ?.correlationId,
                                });
                            }
                        } catch {}

                        return {
                            type: 'error',
                            success: false,
                            content:
                                toolError instanceof Error
                                    ? toolError.message
                                    : String(toolError),
                            metadata: {
                                toolName: action.toolName,
                                arguments: action.input,
                                timestamp: Date.now(),
                                source: 'react-strategy',
                                executionTime: Date.now() - actionStartTime,
                                error: true,
                                errorMessage:
                                    toolError instanceof Error
                                        ? toolError.message
                                        : String(toolError),
                            },
                        };
                    }

                case 'final_answer':
                    this.logger.debug({
                        message: 'Providing final answer',
                        context: this.constructor.name,

                        metadata: {
                            hasContent: !!action.content,

                            contentLength: action.content
                                ? action.content.length
                                : 0,

                            threadId: context.agentContext.thread?.id,
                        },
                    });

                    return {
                        type: 'final_answer',
                        content: action.content,
                        success: true,
                        metadata: {
                            timestamp: Date.now(),
                            source: 'react-strategy',
                            executionTime: Date.now() - actionStartTime,
                        },
                    };

                default:
                    this.logger.error({
                        message: 'Unknown action type',
                        context: this.constructor.name,
                        error: undefined,

                        metadata: {
                            actionType: action.type,
                            threadId: context.agentContext.thread?.id,
                        },
                    });
                    return {
                        type: 'error',
                        success: false,
                        content: `Unknown action type: ${action.type}`,
                        metadata: {
                            timestamp: Date.now(),
                            source: 'react-strategy',
                            executionTime: Date.now() - actionStartTime,
                            error: true,
                            errorMessage: `Unknown action type: ${action.type}`,
                        },
                    };
            }
        } catch (error) {
            this.logger.error({
                message: 'Action execution failed',
                context: this.constructor.name,
                error: error instanceof Error ? error : undefined,

                metadata: {
                    actionType: action.type,
                    executionTime: Date.now() - actionStartTime,
                },
            });
            throw error;
        }
    }

    private async analyzeResult(result: ActionResult): Promise<ResultAnalysis> {
        const analysisStartTime = Date.now();

        try {
            this.logger.debug({
                message: 'Starting result analysis',
                context: this.constructor.name,

                metadata: {
                    resultType: result.type,
                    hasContent: !!result.content,
                    contentType: typeof result.content,
                },
            });

            const isComplete = result.type === 'final_answer';
            const isSuccessful = result.type !== 'error';
            const shouldContinue = result.type === 'tool_result';
            const feedback = this.generateFeedback(result);

            const analysis = {
                isComplete,
                isSuccessful,
                shouldContinue,
                feedback,
                metadata: {
                    resultType: result.type,
                    timestamp: Date.now(),
                    analysisTime: Date.now() - analysisStartTime,
                },
            };

            this.logger.debug({
                message: 'Result analysis completed',
                context: this.constructor.name,

                metadata: {
                    resultType: result.type,
                    isComplete,
                    isSuccessful,
                    shouldContinue,
                    hasFeedback: !!feedback,
                    feedbackLength: feedback.length,
                    analysisTime: Date.now() - analysisStartTime,
                },
            });

            return analysis;
        } catch (error) {
            this.logger.error({
                message: 'Result analysis failed',
                context: this.constructor.name,
                error: error instanceof Error ? error : undefined,

                metadata: {
                    resultType: result.type,
                    analysisTime: Date.now() - analysisStartTime,
                },
            });

            return {
                isComplete: result.type === 'final_answer',
                isSuccessful: false,
                shouldContinue: false,
                feedback: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
                metadata: {
                    resultType: result.type,
                    timestamp: Date.now(),
                    analysisTime: Date.now() - analysisStartTime,
                    error: true,
                },
            };
        }
    }

    private shouldStop(
        _iteration: number,
        toolCallsCount: number,
        startTime: number,
        steps: ExecutionStep[],
    ): boolean {
        if (Date.now() - startTime > this.config.maxExecutionTime) {
            this.logger.log({
                message: 'Stopping: Max execution time reached',
                context: this.constructor.name,
            });
            return true;
        }

        if (toolCallsCount >= this.config.maxToolCalls) {
            this.logger.log({
                message: 'Stopping: Max tool calls reached',
                context: this.constructor.name,
            });
            return true;
        }

        const lastStep = steps[steps.length - 1];
        if (lastStep?.action?.type === 'final_answer') {
            this.logger.log({
                message: 'Stopping: Final answer found',
                context: this.constructor.name,
            });
            return true;
        }

        return false;
    }

    private detectLoop(
        steps: ExecutionStep[],
        actionHistory: string[],
    ): string | null {
        if (actionHistory.length < 3) {
            return null;
        }

        const lastThreeActions = actionHistory.slice(-3);
        const uniqueActions = new Set(lastThreeActions);

        if (uniqueActions.size === 1 && lastThreeActions.length === 3) {
            return lastThreeActions[0] ?? null;
        }

        if (
            lastThreeActions.length === 3 &&
            lastThreeActions[0] === lastThreeActions[2] &&
            lastThreeActions[1] !== lastThreeActions[0]
        ) {
            return lastThreeActions[0] ?? null;
        }

        const recentToolCalls = steps
            .slice(-3)
            .filter((step) => step.action?.type === 'tool_call')
            .map((step) => ({
                toolName: (step.action as any)?.toolName,
                input: JSON.stringify((step.action as any)?.input),
            }));

        if (recentToolCalls.length >= 2) {
            const lastTwo = recentToolCalls.slice(-2);
            if (
                lastTwo.length === 2 &&
                lastTwo[0]?.toolName === lastTwo[1]?.toolName &&
                lastTwo[0]?.input === lastTwo[1]?.input
            ) {
                return `${lastTwo[0]?.toolName} with same parameters`;
            }
        }

        return null;
    }

    private extractFinalResult(steps: ExecutionStep[]): unknown {
        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];

            if (step?.action?.type === 'final_answer' && step.action.content) {
                return step.action.content;
            }
            if (step?.result?.type === 'final_answer' && step.result.content) {
                return step.result.content;
            }
        }

        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step?.result?.type === 'tool_result' && step.result.content) {
                return step.result.content;
            }
        }

        return 'No final result found';
    }

    private parseLLMResponse(content: string, iteration: number): AgentThought {
        // Try native tool calling format first (e.g. Kimi K2.5, DeepSeek)
        // These models respond with <|tool_calls_section_begin|> markers
        const nativeToolCallResult = this.tryParseNativeToolCalls(
            content,
            iteration,
        );
        if (nativeToolCallResult) {
            return nativeToolCallResult;
        }

        const parseResult = EnhancedJSONParser.parse(content);

        if (!parseResult || typeof parseResult !== 'object') {
            this.logger.error({
                message: 'LLM Response Content (Failed Parse): ' + content,
                context: this.constructor.name,
            });
            throw new Error('Failed to parse JSON from LLM response');
        }

        const data = parseResult as any;

        if (!data.reasoning || typeof data.reasoning !== 'string') {
            throw new Error(
                'Missing or invalid reasoning field in LLM response',
            );
        }

        let actionData: any = null;

        if (data.action) {
            actionData = data.action;
        } else if (
            data.hypotheses &&
            Array.isArray(data.hypotheses) &&
            data.hypotheses.length > 0
        ) {
            const firstHypothesis = data.hypotheses[0];
            if (firstHypothesis && firstHypothesis.action) {
                actionData = firstHypothesis.action;
            }
        }

        if (!actionData) {
            throw new Error(
                'Missing action field in LLM response (neither direct nor in hypotheses)',
            );
        }

        const confidence =
            typeof data.confidence === 'number' ? data.confidence : 0.8;

        const thought: AgentThought = {
            reasoning: data.reasoning,
            confidence,
            scratchpadUpdate: data.scratchpadUpdate, // Capture scratchpad update
            action: this.parseActionFromJSON(actionData),
            metadata: {
                iteration,
                timestamp: Date.now(),
                parseMethod: 'enhanced-json-flexible',
            },
        };

        if (data.hypotheses && Array.isArray(data.hypotheses)) {
            thought.hypotheses = data.hypotheses;
        }

        if (data.reflection && typeof data.reflection === 'object') {
            thought.reflection = data.reflection;
        }

        if (data.earlyStopping && typeof data.earlyStopping === 'object') {
            thought.earlyStopping = data.earlyStopping;
        }

        this.logger.debug({
            message: 'Successfully parsed LLM response',
            context: this.constructor.name,

            metadata: {
                reasoningLength: data.reasoning.length,
                confidence,
                actionType: actionData.type,
                hasHypotheses: !!data.hypotheses,
                hasReflection: !!data.reflection,
                hasEarlyStopping: !!data.earlyStopping,
            },
        });

        return thought;
    }

    private parseActionFromJSON(actionData: any): AgentAction {
        if (actionData.type === 'final_answer') {
            return {
                type: 'final_answer',
                content: actionData.content || 'Analysis completed',
            };
        }

        if (actionData.type === 'tool_call') {
            const toolName = actionData.toolName || actionData.tool_name;

            if (!toolName) {
                this.logger.warn({
                    message:
                        'Parsed tool_call without toolName, falling back to final_answer error',
                    context: this.constructor.name,
                });
                return {
                    type: 'final_answer',
                    content:
                        'Error: Attempted to call a tool but no tool name was provided in the action.',
                };
            }

            return {
                type: 'tool_call',
                toolName: toolName,
                input: actionData.input || actionData.parameters || {},
            };
        }

        return {
            type: 'final_answer',
            content: 'Unable to determine action type from LLM response',
        };
    }

    /**
     * Try to parse native tool calling format from models like Kimi K2.5, DeepSeek, etc.
     * These models respond with markers like:
     *   <|tool_calls_section_begin|>
     *   <|tool_call_begin|> functions.toolName:0 <|tool_call_argument_begin|> {"key":"value"} <|tool_call_end|>
     *   <|tool_calls_section_end|>
     *
     * Also handles text before the markers as reasoning.
     * Returns null if the content doesn't match this format.
     */
    private tryParseNativeToolCalls(
        content: string,
        iteration: number,
    ): AgentThought | null {
        if (
            !content.includes('<|tool_call') &&
            !content.includes('<|function_call')
        ) {
            return null;
        }

        this.logger.debug({
            message: 'Detected native tool calling format, attempting parse',
            context: this.constructor.name,
            metadata: { iteration },
        });

        // Extract reasoning (text before the tool calls section)
        const sectionStart = content.indexOf('<|tool_call');
        const reasoning =
            sectionStart > 0
                ? content.substring(0, sectionStart).trim()
                : `Native tool call at iteration ${iteration}`;

        // Parse tool calls
        // Pattern: functions.TOOL_NAME:INDEX <|tool_call_argument_begin|> {JSON} <|tool_call_end|>
        // Use <|tool_call_end|> as the JSON boundary (more reliable than matching braces)
        const toolCallPattern =
            /functions\.(\w+):\d+\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
        let matches = [...content.matchAll(toolCallPattern)];

        if (matches.length === 0) {
            // Try alternative pattern without "functions." prefix
            const altPattern =
                /<\|tool_call_begin\|>\s*(\w+)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
            matches = [...content.matchAll(altPattern)];

            if (matches.length === 0) {
                this.logger.warn({
                    message:
                        'Detected native tool call markers but failed to extract tool calls',
                    context: this.constructor.name,
                    metadata: {
                        iteration,
                        contentPreview: content.substring(0, 300),
                    },
                });
                return null;
            }
        }

        // Use the first tool call (ReAct processes one action at a time)
        const firstMatch = matches[0]!;
        const toolName = firstMatch[1] ?? 'unknown';
        const argsJson = firstMatch[2] ?? '{}';
        let input: Record<string, unknown> = {};
        try {
            input = JSON.parse(argsJson);
        } catch {
            this.logger.warn({
                message: `Failed to parse tool call arguments: ${argsJson}`,
                context: this.constructor.name,
            });
        }

        this.logger.log({
            message: `Parsed native tool call: ${toolName}`,
            context: this.constructor.name,
            metadata: {
                iteration,
                toolName,
                inputKeys: Object.keys(input),
                totalToolCalls: matches.length,
                parseMethod: 'native-tool-calls',
            },
        });

        return {
            reasoning: reasoning || `Calling ${toolName}`,
            confidence: 0.8,
            action: {
                type: 'tool_call',
                toolName,
                input,
            },
            metadata: {
                iteration,
                timestamp: Date.now(),
                parseMethod: 'native-tool-calls',
            },
        };
    }

    private async updateSessionMinimal(
        threadId: string,
        update: {
            iteration: number;
            actionType: string;
            isCompleted: boolean;
            stepId: string;
            toolName?: string;
        },
    ): Promise<void> {
        try {
            const executionUpdate: {
                currentStep?: {
                    id: string;
                    status:
                        | 'pending'
                        | 'executing'
                        | 'completed'
                        | 'failed'
                        | 'skipped';
                };
                status?: 'in_progress' | 'success' | 'error' | 'partial';
                currentTool?: string;
                completedSteps?: string[];
            } = {
                currentStep: {
                    id: update.stepId,
                    status: update.isCompleted ? 'completed' : 'executing',
                },
            };

            if (update.actionType === 'tool_call') {
                executionUpdate.currentTool =
                    update.toolName || 'tool_executing';
            }

            if (update.isCompleted) {
                executionUpdate.status = 'success';
                executionUpdate.completedSteps = [update.stepId];
            } else {
                executionUpdate.status = 'in_progress';
            }

            await ContextService.updateExecution(threadId, executionUpdate);

            this.logger.debug({
                message: 'Session updated (minimal)',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration: update.iteration,
                    stepId: update.stepId,
                    actionType: update.actionType,
                    isCompleted: update.isCompleted,
                },
            });
        } catch (error) {
            this.logger.debug({
                message: 'Session update failed',
                context: this.constructor.name,
                error: error as Error,

                metadata: {
                    threadId,
                },
            });
        }
    }

    private generateFeedback(result: ActionResult): string {
        switch (result.type) {
            case 'final_answer':
                return 'Resposta final fornecida com sucesso.';
            case 'tool_result':
                return 'Ferramenta executada, continuando análise.';
            case 'error':
                return `Erro ocorrido: ${result.error}`;
            default:
                return 'Resultado processado.';
        }
    }

    private buildSuccessResult(
        steps: ExecutionStep[],
        startTime: number,
        iterations: number,
        toolCallsCount: number,
    ): ExecutionResult {
        const finalResult = this.extractFinalResult(steps);
        const executionTime = Date.now() - startTime;

        this.logger.log({
            message: 'ReAct execution completed successfully',
            context: this.constructor.name,

            metadata: {
                steps: steps.length,
                iterations,
                toolCalls: toolCallsCount,
                executionTime,
            },
        });

        return {
            output: finalResult,
            strategy: 'react',
            complexity: steps.length,
            executionTime,
            steps,
            success: true,
            metadata: {
                iterations,
                toolCallsCount,
                finalStepType: steps[steps.length - 1]?.action?.type,
            },
        };
    }

    private buildErrorResult(
        error: unknown,
        steps: ExecutionStep[],
        startTime: number,
        iterations: number,
        toolCallsCount: number,
    ): ExecutionResult {
        const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
        const executionTime = Date.now() - startTime;

        this.logger.error({
            message: 'ReAct execution failed',
            context: this.constructor.name,
            error: error instanceof Error ? error : undefined,

            metadata: {
                stepsCompleted: steps.length,
                iterations,
                toolCalls: toolCallsCount,
                executionTime,
            },
        });

        return {
            output: null,
            strategy: 'react',
            complexity: steps.length,
            executionTime,
            steps,
            success: false,
            error: errorMessage,
            metadata: {
                iterations,
                toolCallsCount,
                failureReason: errorMessage,
            },
        };
    }

    async createFinalResponse(
        context: StrategyExecutionContext,
    ): Promise<string> {
        this.logger.log({
            message: 'ReAct: Creating final response with ContextBridge',
            context: this.constructor.name,
        });

        try {
            const plannerContext = {
                input: context.input,
                history: context.history.map((step, index) => ({
                    ...step,
                    stepId: step.id,
                    executionId: `exec-${Date.now()}-${index}`,
                })) as any[],
                iterations: 1,
                maxIterations: this.config.maxIterations,
                plannerMetadata: {
                    agentName: context.agentContext.agentName,
                    correlationId:
                        context.agentContext.correlationId ||
                        'react-final-response',
                    tenantId: context.agentContext.tenantId || 'default',
                    thread: context.agentContext.thread || {
                        id: context.agentContext.sessionId || 'unknown',
                    },
                    startTime: context.metadata?.startTime || Date.now(),
                    enhancedContext: (context.agentContext as any)
                        .enhancedRuntimeContext,
                },
                agentContext: context.agentContext,
                isComplete: true,
                update: () => {},
                getCurrentSituation: () =>
                    `ReAct strategy completed for: ${context.input}`,
                getFinalResult: () => {
                    const executionResult = (context as any).originalResult;
                    let content = 'ReAct execution completed';

                    if (executionResult?.output) {
                        content = executionResult.output;
                    }

                    return {
                        success: true,
                        result: { content },
                        iterations: 1,
                        totalTime:
                            new Date().getTime() -
                            (context.metadata?.startTime || Date.now()),
                        thoughts: [],
                        metadata: {
                            ...context.metadata,
                            agentName: context.agentContext.agentName,
                            iterations: 1,
                            toolsUsed: context.metadata?.complexity || 0,
                            thinkingTime:
                                Date.now() -
                                (context.metadata?.startTime || Date.now()),
                        } as any,
                    };
                },
                getCurrentPlan: () => null,
            };

            await ContextService.buildFinalResponseContext(plannerContext);

            return (
                (await plannerContext.getFinalResult().result.content) ?? 'Kody'
            );
        } catch (error) {
            this.logger.error({
                message: 'ReAct: ContextBridge failed, using fallback response',
                context: this.constructor.name,
                error: error instanceof Error ? error : undefined,

                metadata: {
                    input: context.input,
                    agentName: context.agentContext.agentName,
                },
            });
            return 'Kody';
        }
    }

    private async forceFinalAnswer(
        context: StrategyExecutionContext,
        iteration: number,
        previousSteps: ExecutionStep[],
        reason: string,
    ): Promise<ExecutionStep> {
        const stepStartTime = Date.now();

        try {
            const threadId = context.agentContext.thread?.id;

            const forceFinalContext = {
                ...context,
                mode: 'final_answer_forced' as any,
                step: previousSteps[previousSteps.length - 1],
            };

            forceFinalContext.history = previousSteps.map((step) => ({
                type: step.type || 'unknown',
                thought: step.thought
                    ? {
                          reasoning: step.thought.reasoning,
                          action: step.action,
                      }
                    : undefined,
                action: step.action,
                result: step.result
                    ? {
                          type: step.result.type,
                          content:
                              step.result.type === 'tool_result'
                                  ? this.summarizeToolResult(step.result)
                                  : step.result.content,
                          success: step.result.type !== 'error',
                      }
                    : undefined,
            })) as ExecutionStep[];

            const prompts =
                this.promptFactory.createReActPrompt(forceFinalContext);

            const finalPrompt = {
                ...prompts,
                userPrompt:
                    prompts.userPrompt +
                    `\n\nCRITICAL SYSTEM OVERRIDE: STOP THINKING. STOP PLANNING. OUTPUT FINAL JSON NOW.\nReason: ${reason}\n\nREQUIRED FORMAT:\n\`\`\`json\n{\n  "reasoning": "Stopping due to limit/error. Summarizing findings.",\n  "confidence": 1.0,\n  "action": {\n    "type": "final_answer",\n    "content": "Your comprehensive summary here..."\n  }\n}\n\`\`\``,
            };

            let response;
            try {
                response = await this.llmAdapter.call({
                    messages: [
                        {
                            role: AgentInputEnum.SYSTEM,
                            content: prompts.systemPrompt,
                        },
                        {
                            role: AgentInputEnum.USER,
                            content: finalPrompt.userPrompt,
                        },
                    ],
                    model: this.llmDefaults?.model,
                    temperature: this.llmDefaults?.temperature,
                    maxTokens: this.llmDefaults?.maxTokens,
                    maxReasoningTokens: this.llmDefaults?.maxReasoningTokens,
                    stop: this.llmDefaults?.stop,
                    signal: context.agentContext?.signal,
                });
            } catch (llmError) {
                const errorMessage =
                    llmError instanceof Error
                        ? llmError.message
                        : String(llmError);

                return {
                    id: `react-step-force-final-${iteration}-${Date.now()}`,
                    type: 'think',
                    type2: 'think' as any,
                    status: 'pending',
                    timestamp: stepStartTime,
                    duration: Date.now() - stepStartTime,
                    action: {
                        type: 'final_answer',
                        content: `I encountered an error while processing your request: ${errorMessage}. Based on the previous steps, here's what I was able to accomplish.`,
                    },
                    metadata: {
                        iteration,
                        strategy: 'react',
                        forcedFinal: true,
                        errorReason: 'llm_error',
                    },
                };
            }

            let content: string;
            if (typeof response.content === 'string') {
                content = response.content;
            } else if (response.content) {
                content = JSON.stringify(response.content);
            } else {
                throw new Error('LLM returned empty or invalid response');
            }

            const parsedThought = this.parseLLMResponse(content, iteration);

            const actionResult = await this.executeAction(
                parsedThought.action,
                context,
            );

            if (threadId) {
                try {
                    await this.updateSessionMinimal(threadId, {
                        iteration: iteration + 1,
                        actionType: 'final_answer',
                        isCompleted: true,
                        stepId: `react-step-force-final-${iteration}`,
                    });
                } catch (error) {
                    this.logger.debug({
                        message: 'Session update failed (non-critical)',
                        context: this.constructor.name,
                        error: error as Error,
                    });
                }
            }

            this.logger.log({
                message: 'Forced final answer completed',
                context: this.constructor.name,

                metadata: {
                    threadId,
                    iteration: iteration + 1,
                    forced: true,
                    reason,
                },
            });

            return {
                id: `react-step-force-final-${iteration}-${Date.now()}`,
                type: 'think',
                type2: 'think' as any,
                status: 'pending',
                timestamp: stepStartTime,
                duration: Date.now() - stepStartTime,
                thought: parsedThought,
                action: parsedThought.action,
                result: actionResult,
                observation: await this.analyzeResult(actionResult),
                metadata: {
                    iteration,
                    strategy: 'react',
                    stepSequence: 'forced-final',
                    forcedFinal: true,
                    reason,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Force final answer failed',
                context: this.constructor.name,
                error: error instanceof Error ? error : undefined,

                metadata: {
                    iteration,
                    reason,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                },
            });

            return {
                id: `react-step-force-final-error-${iteration}-${Date.now()}`,
                type: 'think',
                type2: 'think' as any,
                status: 'pending',
                timestamp: stepStartTime,
                duration: Date.now() - stepStartTime,
                action: {
                    type: 'final_answer',
                    content:
                        'Agent not working as expected enter a contact to support',
                },
                metadata: {
                    iteration,
                    strategy: 'react',
                    stepSequence: 'forced-final-error',
                    forcedFinal: true,
                    reason,
                },
            };
        }
    }

    private summarizeToolResult(result: ActionResult): string {
        if (result.type === 'tool_result' && result.content) {
            try {
                const contentStr =
                    typeof result.content === 'string'
                        ? result.content
                        : JSON.stringify(result.content);

                return `Tool executed successfully - ${contentStr}`;
            } catch {
                return 'Tool executed successfully';
            }
        }

        return 'Tool executed successfully';
    }
}
