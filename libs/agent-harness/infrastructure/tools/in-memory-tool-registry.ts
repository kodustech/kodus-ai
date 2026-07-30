/**
 * agent-harness — InMemoryToolRegistry (generic).
 *
 * Trivial registry over a list of AgentTools: hold them and look up by name. No
 * domain knowledge — domains build it from their own tool adapters.
 */
import type {
    AgentTool,
    ToolRegistry,
} from '../../domain/contracts/tool.contract';

export class InMemoryToolRegistry implements ToolRegistry {
    private readonly byName: Map<string, AgentTool>;

    constructor(tools: readonly AgentTool[]) {
        this.byName = new Map(tools.map((t) => [t.name, t]));
    }

    get(name: string): AgentTool | undefined {
        return this.byName.get(name);
    }

    list(): readonly AgentTool[] {
        return [...this.byName.values()];
    }
}
