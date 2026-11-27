// The engine refuses an org-supplied URL on a private or loopback address
// unless the install's operator allows it (libs/llm/gateway-address-guard.ts,
// API_ALLOWED_PRIVATE_HOSTS): on cloud that covers a BYOK base URL, an MCP
// server and a git server alike. The local servers an eval starts (the scripted
// model, the Kodus MCP and manager, the GitHub REST stand-in) are the eval's
// own: each is allowed the way an operator allows its gateway, by exact host
// and port, and only on loopback, so a route can never open anything else.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function allowLoopback(urlOrOrigin) {
    let url;
    try {
        url = new URL(urlOrOrigin);
    } catch {
        return;
    }
    if (!LOOPBACK.has(url.hostname)) return;
    const entry = `${url.hostname}:${url.port || (url.protocol === 'http:' ? 80 : 443)}`;
    const current = (process.env.API_ALLOWED_PRIVATE_HOSTS || '').split(/[\s,]+/).filter(Boolean);
    if (!current.includes(entry)) process.env.API_ALLOWED_PRIVATE_HOSTS = [...current, entry].join(',');
}

module.exports = { allowLoopback };
