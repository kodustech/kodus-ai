import { isServerSide } from "./server-side";

// Server reads process.env directly. Client reads from the runtime config
// injected by the root layout's inline script into
// window.__KODUS_PUBLIC_CONFIG__ — the runtime-config migration removed
// WEB_NODE_ENV from next.config.js `env:`, so module-scope client callers
// (not just useConfig() hooks) need this window-backed getter.
function getNodeEnv(): string {
    if (isServerSide) {
        return process.env.WEB_NODE_ENV ?? "";
    }
    return (globalThis as any).__KODUS_PUBLIC_CONFIG__?.nodeEnv ?? "";
}

export const isSelfHosted = getNodeEnv() === "self-hosted";
