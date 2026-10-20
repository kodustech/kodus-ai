/**
 * Claude on Vertex: the CLI runs in Vertex mode against the gateway with auth
 * skipped, and the gateway authorizes each request with the slot's service
 * account (or the ambient credentials), on the publisher model path.
 */
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

import type { VertexRoute } from '../../route';
import type { IncomingRequest, Upstream } from './types';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MODEL_PATH = /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/[^/:]+:(rawPredict|streamRawPredict)(\?|$)/;

/** Same host rule as the AI SDK's Vertex provider. */
export function vertexOrigin(route: VertexRoute): string {
    if (route.endpoint) return route.endpoint.replace(/\/+$/, '');
    const r = route.region;
    if (r === 'global') return 'https://aiplatform.googleapis.com';
    if (r === 'eu' || r === 'us') return `https://aiplatform.${r}.rep.googleapis.com`;
    return `https://${r}-aiplatform.googleapis.com`;
}

export type VertexTokenSource = (route: VertexRoute) => Promise<string>;

// One client per service account, so its token is cached and refreshed across
// calls instead of minted per call. Keyed by a hash: the key never holds the JSON.
const clients = new Map<string, GoogleAuth>();
const MAX_CLIENTS = 200;
let adcClient: GoogleAuth | undefined;

/** Access token for the route's credentials; google-auth-library caches and refreshes it. */
export const googleAccessToken: VertexTokenSource = async (route) => {
    let auth: GoogleAuth;
    if (route.credentials === 'adc') {
        adcClient ??= new GoogleAuth({ scopes: [SCOPE] });
        auth = adcClient;
    } else {
        const key = createHash('sha256').update(JSON.stringify(route.credentials)).digest('hex');
        auth = clients.get(key) ?? new GoogleAuth({ credentials: route.credentials as any, scopes: [SCOPE] });
        clients.delete(key);
        clients.set(key, auth);
        if (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value as string);
    }
    const token = await auth.getAccessToken();
    if (!token) throw new Error('vertex: no access token for the slot credentials');
    return token;
};

export async function vertexUpstream(route: VertexRoute, req: IncomingRequest, token: VertexTokenSource = googleAccessToken): Promise<Upstream> {
    const headers = { ...req.headers, authorization: `Bearer ${await token(route)}` };
    const modelRequest = req.method === 'POST' && MODEL_PATH.test(req.path);
    return { kind: 'forward', method: req.method, url: `${vertexOrigin(route)}${req.path}`, headers, body: req.body, modelRequest };
}
