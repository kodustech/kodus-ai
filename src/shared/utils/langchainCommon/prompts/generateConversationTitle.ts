import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';

export const prompt_generate_conversation_title = (
    userMessage: string,
    language = LanguageValue.ENGLISH,
) => {
    return `
    You are an assistant designed to generate short and descriptive titles for conversations in a chat application.

        Here is the initial message from a user in the chat:
        "${userMessage}"

        Based on the message above, generate a short and clear title summarizing the topic of the conversation.

        **Language:** ${language}

        The title must:
        1. Be no longer than 4 words.
        2. Be directly relevant to the user's message.
        3. Avoid generic terms like "Conversation" or "Message."
        4. Focus on the main subject of the user's input.
        5. Be written in the specified language.

        Examples:
        - Message: "How can I learn to code in JavaScript?"
          Title (English): "Learning to Code in JavaScript"
          Title (Portuguese): "Aprendendo a Programar em JavaScript"

        - Message: "What are the best practices for securing APIs?"
          Title (English): "Best Practices for API Security"
          Title (Portuguese): "Melhores Práticas para Segurança de APIs"

        Now, create the title for the provided message.
    `;
};
