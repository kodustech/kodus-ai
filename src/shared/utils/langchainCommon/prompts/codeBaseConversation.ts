export const prompt_codebase_conversation_system = () => {
    return ` You are an AI assistant specialized in answering questions about the team codebase.
    `;
};

export const prompt_codebase_conversation_user = (payload: any) => {
    return `
    User question about codebase: ${payload.question}
    `;
};
