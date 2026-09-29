import { buildSubmitResultTool, submitResultTool } from './finder.agent';

/**
 * #1821: the reason-mode wording ("the walk that produced it… a finding you
 * cannot walk…") made Claude Sonnet 5.5 stop with stop_reason "refusal"
 * (reasoning_extraction). Claude gets evidence wording; everyone else keeps
 * the original text.
 */
describe('submitResult wording for Claude', () => {
    const reasonDesc = (tool: ReturnType<typeof buildSubmitResultTool>) =>
        (tool.inputSchema as any).properties.suggestions.items.properties.reason
            .description as string;

    it('keeps the original reason-mode text for non-Claude models', () => {
        const tool = buildSubmitResultTool(true);
        expect(tool.description).toContain('A finding you cannot walk');
        expect(reasonDesc(tool)).toMatch(/^The walk that produced THIS finding/);
    });

    it('uses the production description and evidence wording for Claude', () => {
        const tool = buildSubmitResultTool(true, true);
        expect(tool.description).toBe(submitResultTool.description);
        expect(tool.description).not.toMatch(/walk/i);
        expect(reasonDesc(tool)).not.toMatch(/walk/i);
        expect(
            (tool.inputSchema as any).properties.suggestions.items.required,
        ).toContain('reason');
    });

    it('leaves the default (no reason mode) untouched', () => {
        expect(buildSubmitResultTool().description).toBe(
            submitResultTool.description,
        );
    });
});
