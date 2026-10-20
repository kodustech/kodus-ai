/**
 * Placed once inside a system prompt, it ends a prefix that several runs share
 * byte for byte (the custom review agents of one review). It never reaches a
 * model: `applyCacheBreakpoints` (prompt-cache.ts) always removes it, and with
 * an inline cache hint splits the system prompt there so the shared prefix
 * gets a breakpoint of its own (4 in all, Anthropic's limit). Without the
 * marker nothing changes. Its own module so a prompt builder can import it
 * without the provider registry.
 */
export const CACHE_PREFIX_BOUNDARY = '<!--kodus:shared-prefix-end-->';
