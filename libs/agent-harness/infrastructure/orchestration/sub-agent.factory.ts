/**
 * agent-harness — SubAgentFactory (sub-agent-as-tool, the keystone primitive).
 *
 * Turns an AgentSpec into a Tool the parent calls like any other. This is the
 * SOTA pattern (OpenAI handoffs, Anthropic orchestrator-worker): one uniform
 * invocation surface, context isolation (the child runs its own window and
 * returns a distilled summary — not its full transcript).
 *
 * What it unlocks, with ZERO new loop code:
 *  - kills the duplicated verify loop: verify = a sub-agent on the same runner
 *  - enables replicas / disagreement-triage (H-REP): spawn N of the same spec
 *  - parent/child orchestration: a parent agent calls children as tools
 *
 * Domain-agnostic and unit-testable: inject a mock AgentRunner, assert the
 * tool runs the spec and returns summarize(state). No LLM required.
 */
import type {
    AgentRunner,
    SubAgentFactory,
} from '../../domain/contracts/agent.contract';
import type { JSONSchema } from '../../domain/contracts/json-schema.contract';
import type { AgentTool } from '../../domain/contracts/tool.contract';

const DEFAULT_INPUT_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        task: { type: 'string', description: 'The task for the sub-agent.' },
    },
    required: ['task'],
};

export class DefaultSubAgentFactory implements SubAgentFactory {
    constructor(private readonly runner: AgentRunner) {}

    asTool(params: {
        name: string;
        description: string;
        spec: import('../../domain/contracts/agent.contract').AgentSpec;
        inputSchema?: JSONSchema;
        toPrompt: (input: unknown) => string;
        summarize: (
            state: import('../../domain/contracts/run-state.contract').RunState,
        ) => string;
    }): AgentTool {
        const { name, description, spec, toPrompt, summarize } = params;
        const inputSchema = params.inputSchema ?? DEFAULT_INPUT_SCHEMA;
        const runner = this.runner;

        return {
            name,
            description,
            inputSchema,
            async execute(input, ctx) {
                const prompt = toPrompt(input);
                const state = await runner.run(spec, { prompt }, ctx);
                return {
                    output: summarize(state),
                    meta: {
                        subAgentId: spec.id,
                        status: state.status,
                        steps: state.steps.length,
                    },
                };
            },
        };
    }
}
