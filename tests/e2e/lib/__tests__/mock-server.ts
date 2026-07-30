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
        executionsRoute(),
        healthRoute(),
    ];
}

/**
 * The runner's post-failure reachability probe (isTargetReachable, added in
 * #1494) GETs /health and reclassifies a genuine scenario failure as
 * SKIP/inconclusive when it doesn't answer 200 — without this route, mock
 * targets always look "unreachable" and the license-gate tests that assert
 * a real `failed` outcome get `skipped` instead.
 */
export function healthRoute(): RouteHandler {
    return {
        method: "GET",
        pathRegex: /^\/health(\?|$)/,
        handler: (_req, res) => json(res, 200, { status: "ok" }),
    };
}

/**
 * Execution-health assert (assertHealthyExecution) polls this after every
 * review. #1494 added the assert without teaching the mocks the route, which
 * silently broke the whole hermetic integration layer on main (7 tests red
 * from 2026-07-10). Exported separately because integration.test.ts and
 * integration-license.test.ts carry their own inline route tables.
 * Returns one settled execution (default "success") for any PR queried.
 *
 * The SAME trap fired again in #1547: assertPersistedSuggestions was added to
 * code-review-basic and polls this route for `suggestionsCount.sent`, which the
 * row did not carry — so it polled its full 120s, failed, and the runner's
 * retry burned another 120s. That one test alone spent 260s of the job's 5min
 * budget and turned main red (as a *timeout*, reported as "cancelled") from
 * 2026-07-14. An assert that reads a field the mock never emits cannot pass:
 * when adding one, extend this row in the same commit.
 */
export function executionsRoute(
    status: string = "success",
    suggestionsSent: number = 1,
): RouteHandler {
    return {
        method: "GET",
        pathRegex: /^\/pull-requests\/executions(\?|$)/,
        handler: (req, res) => {
            const url = new URL(req.url ?? "", "http://mock");
            const prNumber = Number(
                url.searchParams.get("pullRequestNumber") ?? 0,
            );
            // Mirror the REAL enriched-listing shape (verified against QA):
            // the item's top-level `status` is the PULL REQUEST state
            // ("open"), and the execution status lives nested under
            // `automationExecution.status`. An idealized mock here is how
            // the walker's PR-state-vs-execution-status bug slipped through.
            json(res, 200, {
                data: {
                    data: [
                        {
                            prNumber,
                            status: "open",
                            executionId: "exec-1",
                            automationExecution: { status },
                            // Read back by assertPersistedSuggestions — the
                            // store-side counterpart of the posted comments.
                            suggestionsCount: { sent: suggestionsSent },
                        },
                    ],
                },
            });
        },
    };
}

/** Helper type used by every provider's review-window state. */
export interface ReviewWindow {
    triggeredAt: string;
}

