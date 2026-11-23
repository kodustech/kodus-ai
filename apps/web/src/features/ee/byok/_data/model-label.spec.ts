import { modelLabeler } from "./model-label";

describe("modelLabeler", () => {
    it("names a pinned id and its alias by their ids, and only them", () => {
        const label = modelLabeler([
            "deepseek-ai/DeepSeek-V4.1-Flash",
            "deepseek-ai/DeepSeek-V4.1-Flash-1017",
            "kimi-k2.6",
            "gpt-5.4",
            "openai/gpt-5.4",
        ]);
        expect(label("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(
            "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash)",
        );
        expect(label("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe(
            "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash-1017)",
        );
        expect(label("kimi-k2.6")).toBe("Kimi K2.6");
        expect(label("gpt-5.4")).toBe("GPT 5.4");
        expect(label("openai/gpt-5.4")).toBe("GPT 5.4");
    });

    it("names an id outside the list when a listed one shares its label", () => {
        expect(modelLabeler(["gpt-5.4"])("gpt-5.4-2026-03-05")).toBe(
            "GPT 5.4 (gpt-5.4-2026-03-05)",
        );
    });
});
