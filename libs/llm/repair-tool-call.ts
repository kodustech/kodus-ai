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
import {
    ensureValidatingSchema,
    readOutput,
    salvageStructuredError,
} from '@libs/llm/structured-output-repair';

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

    // Guarantee the correction is VALIDATED against the tool schema. A raw
    // jsonSchema() would let Output.object parse-but-not-check, so a still-wrong
    // correction would be blindly accepted — the same silent-mismatch class the
    // one-shot review path had (#1786). `ensureValidatingSchema` is the SHARED
    // recovery toolkit: both structured entry points (this tool-call path and
    // runStructuredReviewCall) now heal through the same primitives.
    const validatingSchema = ensureValidatingSchema(
        jsonSchema((await inputSchema({ toolName: toolCall.toolName })) as any),
    );

    try {
        // `generateText` + `Output.object` (not the deprecated `generateObject`)
        // — one structured re-ask against the SAME model. Same output plumbing as
        // the review executor: pass `output`, read `experimental_output`/`output`.
        // Output.object now validates the correction against the schema and throws
        // NoObjectGeneratedError if it still doesn't conform.
        const result = await generateText({
            model,
            abortSignal,
            output: Output.object({ schema: validatingSchema as any }),
            prompt: [
                `The tool "${toolCall.toolName}" was called with arguments that failed schema validation.`,
                `Invalid arguments: ${JSON.stringify(toolCall.input)}`,
                `Validation error: ${(error as Error)?.message ?? String(error)}`,
                `Return corrected arguments that satisfy the schema. Keep the original intent; only fix what is malformed.`,
            ].join('\n'),
        } as any);
        return { ...toolCall, input: JSON.stringify(readOutput(result)) };
    } catch (err) {
        // The correction failed to parse/validate. The SHARED salvage does the
        // same free deterministic repair the one-shot path uses (fenced / prose-
        // wrapped JSON), held to the SAME tool schema — a valid recovery is
        // accepted, a still-wrong shape (or any other error) → null = the SDK's
        // default "don't repair, fail the step" (kept fully fail-soft).
        const recovered = await salvageStructuredError(err, validatingSchema);
        if (recovered !== undefined) {
            return { ...toolCall, input: JSON.stringify(recovered) };
        }
        return null;
    }
}
