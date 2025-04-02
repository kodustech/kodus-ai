import Anthropic from "@anthropic-ai/sdk";
import { LLMModelProvider } from "../domain/enums/llm-model-provider.enum";
import { getLLMModelProviderWithFallback } from "./get-llm-model-provider.util";

export class AnthropicAPI {
    private readonly anthropic: Anthropic;
    private readonly model: string;
    private readonly temperature: number;

    constructor(model?: string, temperature?: number) {
        this.anthropic = new Anthropic({
            apiKey: process.env.API_ANTHROPIC_API_KEY
        });

        this.model = model || getLLMModelProviderWithFallback(
            LLMModelProvider.CLAUDE_3_5_SONNET,
        );
        this.temperature = temperature || 0;

    }

    async invokeText(message: any) {
        try {
            return await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 1024,
                temperature: this.temperature,
                messages: [{ role: "user", content: message }]
            },
                {
                    headers: {
                        "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"
                    }
                })
        } catch (error) {
            console.log(error);
        }
    };
}


