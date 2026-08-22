/**
 * `PromptRole` — the message-role taxonomy for prompt construction. Member names
 * and string values are runtime-load-bearing; don't edit a value without checking
 * every consumer.
 */
export enum PromptRole {
    SYSTEM = 'system',
    USER = 'user',
    AI = 'ai',
    CUSTOM = 'custom',
}
