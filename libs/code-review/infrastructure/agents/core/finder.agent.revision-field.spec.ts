import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import {
    buildFinderAgentSpec,
    FINDER_DONE_TOOL,
    submitResultTool,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';

const doneTool = (acceptsRevisions?: boolean) =>
    buildFinderAgentSpec({
        systemPrompt: 'find bugs',
        modelId: 'm',
        tools: new InMemoryToolRegistry([]),
        coverageLedger: { markFromToolCall: () => undefined, summary: () => ({}) as any, debtNote: () => null } as any,
        acceptsRevisions,
    })
        .tools.list()
        .find((t) => t.name === FINDER_DONE_TOOL)!;

const itemProps = (schema: any) => schema.properties.suggestions.items.properties;

// A first-round review (no earlier suggestions) must send the finder exactly
// the done-tool it always did: an extra field there measurably moved recall
// on the nightly set, where no PR has history.
describe('finder done-tool: revisesSuggestionId only when the PR has history', () => {
    it('no history → the schema is the unchanged one', () => {
        expect(doneTool().inputSchema).toEqual(submitResultTool.inputSchema);
        expect(itemProps(doneTool().inputSchema)).not.toHaveProperty('revisesSuggestionId');
    });

    it('history → each finding may name the earlier suggestion it revises', () => {
        expect(itemProps(doneTool(true).inputSchema).revisesSuggestionId).toEqual({ type: 'string' });
        // the shared constant is never mutated
        expect(itemProps(submitResultTool.inputSchema)).not.toHaveProperty('revisesSuggestionId');
    });
});
