/**
 * Claude on Bedrock: the CLI runs in Bedrock mode against the gateway with auth
 * skipped; the gateway signs each request with the slot's IAM keys (SigV4) or
 * sends its API key as a bearer, and the event stream comes back unchanged.
 *
 * The CLI lists inference profiles before its first call. That is the control
 * plane, which a runtime-only key may not reach, so the gateway answers it
 * with an empty list and the CLI uses the slot's model id as given.
 */
import { AwsV4Signer } from 'aws4fetch';

import type { BedrockRoute } from '../../route';
import type { IncomingRequest, Upstream } from './types';

const MODEL_PATH = /^\/model\/[^/]+\/(invoke|invoke-with-response-stream)(\?|$)/;

export function bedrockOrigin(route: BedrockRoute): string {
    return route.endpoint ? route.endpoint.replace(/\/+$/, '') : `https://bedrock-runtime.${route.region}.amazonaws.com`;
}

export async function bedrockUpstream(route: BedrockRoute, req: IncomingRequest): Promise<Upstream> {
    if (req.method === 'GET' && /^\/inference-profiles(\?|$)/.test(req.path)) {
        return { kind: 'local', status: 200, body: { inferenceProfileSummaries: [] } };
    }
    // The CLI writes the model id raw (`…-v1:0`); AWS's clients send it
    // percent-encoded, and SigV4 signs the encoded path.
    const path = req.path.replace(/^\/model\/([^/]+)\//, (_m, id: string) => `/model/${encodeURIComponent(decodeURIComponent(id))}/`);
    const url = `${bedrockOrigin(route)}${path}`;
    const modelRequest = req.method === 'POST' && MODEL_PATH.test(req.path);
    const headers = { ...req.headers };
    delete headers.authorization;
    if (route.auth.kind === 'bearer') {
        headers.authorization = `Bearer ${route.auth.token}`;
        return { kind: 'forward', method: req.method, url, headers, body: req.body, modelRequest };
    }
    const signer = new AwsV4Signer({
        method: req.method,
        url,
        headers,
        body: req.body.length ? new Uint8Array(req.body) : undefined,
        accessKeyId: route.auth.accessKeyId,
        secretAccessKey: route.auth.secretAccessKey,
        sessionToken: route.auth.sessionToken,
        service: 'bedrock',
        region: route.region,
    });
    const signed = await signer.sign();
    const signedHeaders: Record<string, string> = {};
    signed.headers.forEach((value, key) => {
        signedHeaders[key] = value;
    });
    return { kind: 'forward', method: req.method, url, headers: signedHeaders, body: req.body, modelRequest };
}
