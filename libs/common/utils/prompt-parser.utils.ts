import { createHash } from 'crypto';

/**
 * Calculates SHA-256 hash of a prompt string
 * @param promptText The prompt text to hash
 * @returns Hex string of the hash
 */
export function calculatePromptHash(promptText: string): string {
    return createHash('sha256').update(promptText).digest('hex');
}
