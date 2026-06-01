import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface RouteHandler {
    method: string;
    pathRegex: RegExp;
    handler: (
        req: IncomingMessage,
        res: ServerResponse,
        match: RegExpMatchArray,
        body: string,
    ) => Promise<void> | void;
}

export interface MockServer {
    baseUrl: string;
    close: () => Promise<void>;
    requests: Array<{ method: string; path: string; body: string }>;
}

/**
 * Builds a base64url-encoded JWT with a custom payload. Used to simulate the
 * Kodus /auth/login response — the onboarding layer decodes the payload to
 * extract organizationId, so the mock needs to produce a valid-looking JWT.
 */
export function makeFakeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
        .toString("base64")
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const body = Buffer.from(JSON.stringify(payload))
        .toString("base64")
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    return `${header}.${body}.sig`;
}

export async function startMockServer(
    routes: RouteHandler[],
): Promise<MockServer> {
    const requests: MockServer["requests"] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "/";
            requests.push({ method: req.method ?? "GET", path, body });

            for (const route of routes) {
                if (route.method !== req.method) continue;
                const match = path.match(route.pathRegex);
                if (!match) continue;
                try {
                    await route.handler(req, res, match, body);
                } catch (err) {
                    res.statusCode = 500;
                    // Explicit JSON content-type so the reflected request
                    // method/path/error text is never interpreted as HTML
                    // by a browser (CodeQL js/reflected-xss + exception-as-
                    // HTML). This is a localhost test mock, but setting the
                    // header is both correct and silences the scanner.
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `no route for ${req.method} ${path}` }));
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    return {
        baseUrl,
        requests,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
}

/**
 * Standard Kodus-side routes used by all provider integration tests. The
 * provider-specific routes (webhook trigger + comment polling) are added
 * separately per provider — those live in their own builder functions.
 */
export function kodusRoutes(opts: {
    orgId: string;
    teamId: string;
    repoId: string | number;
    repoFullName: string;
    repoName?: string;
}): RouteHandler[] {
    return [
        {
            method: "POST",
            pathRegex: /^\/auth\/(signUp|signup)$/,
            handler: (_req, res) =>
                json(res, 201, {
                    data: { uuid: "user-1", email: "mock@kodus.local" },
                }),
        },
        {
            method: "POST",
            pathRegex: /^\/auth\/login$/,
            handler: (_req, res) =>
                json(res, 200, {
                    data: {
                        accessToken: makeFakeJwt({
                            organizationId: opts.orgId,
                            sub: "user-1",
                        }),
                    },
                }),
        },
        {
            method: "GET",
            pathRegex: /^\/team\/$/,
            handler: (_req, res) =>
                json(res, 200, { data: [{ uuid: opts.teamId }] }),
        },
        {
            method: "POST",
            pathRegex: /^\/code-management\/auth-integration$/,
            handler: (_req, res) =>
                json(res, 200, { data: { status: "SUCCESS" } }),
        },
        {
            method: "GET",
            pathRegex: /^\/code-management\/repositories\/org/,
            handler: (_req, res) =>
                json(res, 200, {
                    data: [
                        {
                            id: opts.repoId,
                            full_name: opts.repoFullName,
                            name: opts.repoName ?? opts.repoFullName,
                        },
                    ],
                }),
        },
        {
            method: "POST",
            pathRegex: /^\/code-management\/repositories$/,
            handler: (_req, res) =>
                json(res, 200, { data: { status: true } }),
        },
        {
            method: "POST",
            pathRegex: /^\/code-management\/finish-onboarding$/,
            handler: (_req, res) => json(res, 200, {}),
        },
    ];
}

/** Helper type used by every provider's review-window state. */
export interface ReviewWindow {
    triggeredAt: string;
}

