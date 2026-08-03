import { capabilityGate } from "./capability-gate";

/**
 * The client capability predicate is a pure mirror of the backend's
 * TASK_CAPABILITY_REQUIREMENTS (libs/llm/static-task-strategy.ts):
 *  - codeReview   requires structured output — natively OR via native tools
 *  - conversation requires toolCalling === 'native'
 *  - prSummary    has no requirement
 * caps undefined → soft-OK (never a hard block; the backend is the backstop).
 */
describe("capabilityGate", () => {
    // OpenAI-like: native structured output + native tools → compatible with all.
    const full = { structuredOutput: "json_schema", toolCalling: "native" };
    // Anthropic-like: NO native structured output, but native tools → structured
    // output via tool use, so still eligible for codeReview.
    const noStructured = { structuredOutput: "none", toolCalling: "native" };
    // Structured output but no native tool calling.
    const noTools = { structuredOutput: "json_object", toolCalling: "none" };
    // Neither native structured output nor native tools → fails codeReview.
    const neither = { structuredOutput: "none", toolCalling: "none" };

    describe("codeReview (requires structured output, natively or via tools)", () => {
        it("passes a native structured-output model", () => {
            expect(capabilityGate("codeReview", full).ok).toBe(true);
        });

        it("passes a tool-native model without native structured output", () => {
            expect(capabilityGate("codeReview", noStructured).ok).toBe(true);
        });

        it("blocks a model with neither structured output nor native tools", () => {
            const result = capabilityGate("codeReview", neither);
            expect(result.ok).toBe(false);
            expect(result.reason).toBeTruthy();
        });
    });

    describe("conversation (requires native tool calling)", () => {
        it("passes a native tool-calling model", () => {
            expect(capabilityGate("conversation", full).ok).toBe(true);
        });

        it("blocks a model without native tool calling", () => {
            const result = capabilityGate("conversation", noTools);
            expect(result.ok).toBe(false);
            expect(result.reason).toBeTruthy();
        });
    });

    describe("prSummary (no requirement)", () => {
        it("passes any model", () => {
            expect(capabilityGate("prSummary", full).ok).toBe(true);
            expect(capabilityGate("prSummary", noStructured).ok).toBe(true);
            expect(capabilityGate("prSummary", noTools).ok).toBe(true);
        });
    });

    describe("unknown capabilities (soft-OK)", () => {
        it("returns { ok: true, unknown: true } when caps is undefined", () => {
            const result = capabilityGate("codeReview", undefined);
            expect(result.ok).toBe(true);
            expect(result.unknown).toBe(true);
        });

        it("never blocks a task on unknown caps (backend stays the backstop)", () => {
            expect(capabilityGate("conversation", undefined).ok).toBe(true);
            expect(capabilityGate("prSummary", undefined).ok).toBe(true);
        });
    });

    describe("tooltip reason", () => {
        it("names the model in a human-readable reason when !ok", () => {
            const result = capabilityGate(
                "codeReview",
                neither,
                "some-basic-model",
            );
            expect(result.ok).toBe(false);
            expect(result.reason).toContain("some-basic-model");
        });
    });
});
