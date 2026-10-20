/**
 * Anthropic-format upstreams: Anthropic itself (a team's key, Kodus credits,
 * the self-hosted env key), OpenRouter's Anthropic endpoint and LiteLLM-style
 * `anthropic_compatible` proxies. The body goes as the CLI wrote it; the two
 * edits are the slot's OpenRouter provider pin and A9's temperature.
 */
import type { AnthropicFormatRoute } from '../../route';
import type { IncomingRequest, Upstream } from './types';

const MODEL_PATH = /^\/v1\/messages(\?|$)/;

/**
 * A9: Claude ≥4.7 rejects `temperature`, and a thinking request only takes 1,
 * so the caller's temperature goes on an older model's request without thinking.
 */
export function acceptsTemperature(model: string, body: Record<string, any>): boolean {
    if (body.thinking && body.thinking.type !== 'disabled') return false;
    const m = String(model).toLowerCase().match(/claude-(?:(opus|sonnet|haiku)-)?(\d+)(?:[-.](\d+))?/);
    if (!m) return false;
    const major = Number(m[2]);
    const minor = m[3] && m[3].length <= 2 ? Number(m[3]) : 0;
    return major < 4 || (major === 4 && minor < 7);
}

/** Body edits for this route, or null when the bytes go unchanged. */
export function editBody(route: AnthropicFormatRoute, raw: Buffer, temperature?: number): Buffer | null {
    const wantsPin = !!route.openrouterProvider;
    if (!wantsPin && temperature === undefined) return null;
    let body: Record<string, any>;
    try {
        body = JSON.parse(raw.toString('utf8'));
    } catch {
        return null;
    }
    let changed = false;
    if (wantsPin && body.provider === undefined) {
        body.provider = route.openrouterProvider;
        changed = true;
    }
    if (temperature !== undefined && body.temperature === undefined && acceptsTemperature(body.model, body)) {
        body.temperature = temperature;
        changed = true;
    }
    return changed ? Buffer.from(JSON.stringify(body), 'utf8') : null;
}

export function anthropicUpstream(route: AnthropicFormatRoute, req: IncomingRequest, temperature?: number): Upstream {
    const headers = { ...req.headers };
    if (route.auth === 'x-api-key') headers['x-api-key'] = route.apiKey;
    else headers.authorization = `Bearer ${route.apiKey}`;
    const modelRequest = req.method === 'POST' && MODEL_PATH.test(req.path);
    const body = modelRequest ? (editBody(route, req.body, temperature) ?? req.body) : req.body;
    return { kind: 'forward', method: req.method, url: `${route.baseUrl.replace(/\/+$/, '')}${req.path}`, headers, body, modelRequest };
}
