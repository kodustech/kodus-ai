import type { ModelMessage } from 'ai';
import type { AgentLoopSeams } from '@libs/llm/agent-loop-call';
import type { AgentLoopResult, LlmRequest } from '@libs/llm/llm';

/** The same complete SDK loop the runner invokes today, not a single model turn. */
export type AgentLoopInvocation = LlmRequest & {
    loop: AgentLoopSeams;
    messages: ModelMessage[];
    schema?: undefined;
};

/** Injectable infrastructure boundary; tools and policy callbacks remain local. */
export type AgentLoopInvoker = (
    request: AgentLoopInvocation,
) => Promise<AgentLoopResult>;
