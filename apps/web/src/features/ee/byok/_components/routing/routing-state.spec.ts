import type { LLMConfigStatus } from "@services/organizationParameters/fetch";

import { routingModelLabels } from "./routing-state";

const slot = (
    modelId: string,
    model: string,
    extra: Partial<LLMConfigStatus["models"][number]> = {},
) =>
    ({
        modelId,
        model,
        providerId: "together",
        ...extra,
    }) as LLMConfigStatus["models"][number];

describe("routingModelLabels", () => {
    it("names a pinned model and its alias on one provider by their ids", () => {
        const labels = routingModelLabels([
            slot("a", "deepseek-ai/DeepSeek-V4.1-Flash"),
            slot("b", "deepseek-ai/DeepSeek-V4.1-Flash-1017"),
        ]);
        expect(labels.get("a")).toBe(
            "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash)",
        );
        expect(labels.get("b")).toBe(
            "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash-1017)",
        );
    });

    it("still names the connection when one id is on two providers", () => {
        const labels = routingModelLabels([
            slot("a", "gpt-5.4", { providerId: "openai" }),
            slot("b", "gpt-5.4", { providerId: "openrouter" }),
        ]);
        expect(labels.get("a")).toMatch(/^GPT 5\.4 · /);
        expect(labels.get("a")).not.toBe(labels.get("b"));
    });

    it("leaves the managed default plain", () => {
        const labels = routingModelLabels([
            slot("env", "gpt-5.4-2026-03-05", { managed: true }),
            slot("a", "gpt-5.4"),
        ]);
        expect(labels.get("env")).toBe("GPT 5.4");
        expect(labels.get("a")).toBe("GPT 5.4");
    });
});
