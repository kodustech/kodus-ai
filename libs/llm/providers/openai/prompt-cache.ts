/**
 * Prompt-cache marker for a prefix several one-shot calls share, on OpenAI's
 * own API.
 *
 * From gpt-5.6 on, OpenAI caches like Anthropic: in its default (implicit)
 * mode it puts a breakpoint on the latest message, so every call of a batch
 * writes its whole, unique prompt and none reads another's prefix. A shared
 * prefix becomes readable only with an explicit `prompt_cache_breakpoint` on
 * its last block; explicit mode on the request also stops the automatic
 * breakpoint from writing each call's unique tail. Models before 5.6 and
 * other hosts (Azure, gateways) keep the implicit default.
 */
import type { PrefixCacheHint, ProviderBuildConfig } from '../kernel/types';
import { isOpenAiHost } from './endpoint';

/** gpt-5.6 and later (gpt-5.6-*, gpt-6, gpt-6.1-*, …). */
export function takesExplicitCacheBreakpoints(model: string): boolean {
    const m = /^gpt-(\d+)(?:\.(\d+))?(?![\d.])/i.exec(model.trim());
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2] ?? 0);
    return major > 5 || (major === 5 && minor >= 6);
}

export function openAiPrefixCacheHint(
    cfg: ProviderBuildConfig,
): PrefixCacheHint | undefined {
    if (cfg.provider !== 'openai') return undefined;
    if (cfg.baseURL && !isOpenAiHost(cfg.baseURL)) return undefined;
    if (!takesExplicitCacheBreakpoints(cfg.model ?? '')) return undefined;
    return {
        part: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
        request: { openai: { promptCacheOptions: { mode: 'explicit' } } },
    };
}
