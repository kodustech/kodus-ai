import { getLLMModelProviderWithFallback } from "./get-llm-model-provider.util";

import { LLMModelProvider } from "../domain/enums/llm-model-provider.enum";

const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require('@google/generative-ai');

export const getGemini = async (params?: {
    model?: string;
    temperature?: number;
    responseMimeType?: string;
}) => {
    const genAI = new GoogleGenerativeAI(process.env.API_GOOGLE_AI_API_KEY);

    const llm = genAI.getGenerativeModel({
        model: params.model || getLLMModelProviderWithFallback(
            LLMModelProvider.GEMINI_1_5_PRO,
        ),
    });

    return llm.startChat({
        generationConfig: {
            temperature: params.temperature || 0,
            responseMimeType: params.responseMimeType || 'text/plain',
        },
        history: [],
    });
};
