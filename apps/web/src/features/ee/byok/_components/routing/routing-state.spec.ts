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
    it("names a pinned model and its alias by id, and the same id on two connections by connection", () => {
        const labels = routingModelLabels([
            slot("alias", "deepseek-ai/DeepSeek-V4.1-Flash"),
            slot("pin", "deepseek-ai/DeepSeek-V4.1-Flash-1017"),
            slot("openai", "gpt-5.4", { providerId: "openai" }),
            slot("openrouter", "openai/gpt-5.4", { providerId: "openrouter" }),
            slot("env", "gpt-5.4-2026-03-05", { managed: true }),
        ]);

        expect(labels.get("alias")).toBe(
            "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash)",
        );
        expect(labels.get("pin")).toBe(
            "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash-1017)",
        );
        expect(labels.get("openai")).toBe("GPT 5.4 · OpenAI");
        expect(labels.get("openrouter")).toBe("GPT 5.4 · OpenRouter");
        expect(labels.get("env")).toBe("GPT 5.4");
    });
});
