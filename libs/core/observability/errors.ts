/**
 * Minimal replacement for the legacy flow engine's `isEnhancedError`. In flow this was an
 * `instanceof` check against EnhancedAgentError / EnhancedToolError /
 * EnhancedKernelError. Those classes live inside flow's engine and are not
 * ported here, so this duck-types on the distinctive structured `context`
 * carried by flow's enhanced errors. Call sites immediately cast to `any` and
 * read `error.context?.subcode` / `error.code` behind optional chaining, so the
 * exact narrowing is irrelevant — only the boolean gate matters.
 */
export function isEnhancedError(error: Error): boolean {
    const e = error as any;
    return !!e && e.context != null && typeof e.context === 'object';
}
