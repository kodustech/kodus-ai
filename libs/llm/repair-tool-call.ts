/**
 * Tool-call self-heal for the AI SDK `repairToolCall` seam. When a tool call's
 * input fails schema validation, re-ask the SAME model to correct the arguments
 * against the tool's schema. Fully fail-soft: a wrong tool NAME can't be repaired
 * here (pass through), and ANY error resolves to `null` — exactly the SDK's
 * default "don't repair, let the step fail" behaviour.
 *
 * Lives in `@libs/llm` (not the harness) because it is a MODEL-call concern: it
 * re-issues against the resolved model, which `LLM.run` owns. `LLM.run`'s agent
 * loop wires it into `generateText({ repairToolCall })`; the harness never
 * resolves a model itself.
 */
import {
    generateText,
    jsonSchema,
    NoSuchToolError,
    Output,
    type LanguageModel,
} from 'ai';

export async function repairInvalidToolInput(opts: {
    model: LanguageModel;
    abortSignal?: AbortSignal;
    toolCall: { toolName: string; input: unknown; [k: string]: unknown };
    inputSchema: (o: { toolName: string }) => PromiseLike<unknown>;
    error: unknown;
}): Promise<Record<string, unknown> | null> {
    const { model, abortSignal, toolCall, inputSchema, error } = opts;
    if (NoSuchToolError.isInstance(error)) {
        return null;
    }
    try {
        // `generateText` + `Output.object` (not the deprecated `generateObject`)
        // — one structured re-ask against the SAME model. Same output plumbing as
        // the review executor: pass `output`, read `experimental_output`/`output`.
        const result = await generateText({
            model,
            abortSignal,
            output: Output.object({
                schema: jsonSchema(
                    (await inputSchema({ toolName: toolCall.toolName })) as any,
                ),
            }),
            prompt: [
                `The tool "${toolCall.toolName}" was called with arguments that failed schema validation.`,
                `Invalid arguments: ${JSON.stringify(toolCall.input)}`,
                `Validation error: ${(error as Error)?.message ?? String(error)}`,
                `Return corrected arguments that satisfy the schema. Keep the original intent; only fix what is malformed.`,
            ].join('\n'),
        } as any);
        const repaired =
            (result as any).experimental_output ?? (result as any).output;
        return { ...toolCall, input: JSON.stringify(repaired) };
    } catch {
        // Repair itself failed → behave exactly as before (fail the call).
        return null;
    }
}
