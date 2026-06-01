import http from 'node:http';

export interface RecordedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
}

export interface MockServer {
    url: string;
    port: number;
    requests: RecordedRequest[];
    close: () => Promise<void>;
    reset: () => void;
}

const REVIEW_DATA = {
    summary: 'Found 2 issues in 1 file',
    issues: [
        {
            file: 'test.ts',
            line: 1,
            severity: 'warning',
            message: 'Consider using const instead of let',
            category: 'best_practices',
        },
        {
            file: 'test.ts',
            line: 3,
            severity: 'error',
            message: 'Unused variable',
            category: 'code_quality',
        },
    ],
    filesAnalyzed: 1,
    duration: 1234,
};

const PR_SUGGESTIONS_DATA = {
    summary: 'PR suggestions',
    issues: [
        {
            file: 'PR',
            line: 1,
            severity: 'info',
            message: 'Add more context to the PR description',
            category: 'documentation',
        },
    ],
    filesAnalyzed: 1,
    duration: 321,
};

export async function startMockServer(): Promise<MockServer> {
    const requests: RecordedRequest[] = [];

    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const bodyStr = Buffer.concat(chunks).toString();
        let body: any;
        try {
            body = JSON.parse(bodyStr);
        } catch {
            body = bodyStr;
        }

        requests.push({
            method: req.method!,
            url: req.url!,
            headers: req.headers,
            body,
        });

        res.setHeader('Content-Type', 'application/json');
        const url = req.url!;
        const method = req.method!;

        if (method === 'POST' && url === '/cli/review') {
            res.writeHead(200);
            res.end(JSON.stringify({ data: REVIEW_DATA, statusCode: 200 }));
        } else if (
            method === 'GET' &&
            url.startsWith('/pull-requests/suggestions')
        ) {
            res.writeHead(200);
            res.end(
                JSON.stringify({ data: PR_SUGGESTIONS_DATA, statusCode: 200 }),
            );
        } else if (method === 'POST' && url === '/cli/trial/review') {
            res.writeHead(200);
            res.end(
                JSON.stringify({
                    data: {
                        ...REVIEW_DATA,
                        trialInfo: {
                            reviewsUsed: 3,
                            reviewsLimit: 5,
                            resetsAt: new Date(
                                Date.now() + 86400000,
                            ).toISOString(),
                        },
                    },
                    statusCode: 200,
                }),
            );
        } else if (method === 'GET' && url.startsWith('/cli/trial/status')) {
            res.writeHead(200);
            res.end(
                JSON.stringify({
                    data: {
                        fingerprint: 'test-fp',
                        reviewsUsed: 2,
                        reviewsLimit: 5,
                        filesLimit: 10,
                        linesLimit: 500,
                        resetsAt: new Date(Date.now() + 86400000).toISOString(),
                        isLimited: false,
                    },
                    statusCode: 200,
                }),
            );
        } else if (method === 'POST' && url === '/auth/login') {
            res.writeHead(200);
            res.end(
                JSON.stringify({
                    data: {
                        accessToken: 'mock-access-token',
                        refreshToken: 'mock-refresh-token',
                    },
                    statusCode: 200,
                }),
            );
        } else if (method === 'POST' && url === '/auth/logout') {
            res.writeHead(200);
            res.end(JSON.stringify({ data: null, statusCode: 200 }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ message: `Not found: ${method} ${url}` }));
        }
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                port: addr.port,
                requests,
                close: () => new Promise<void>((r) => server.close(() => r())),
                reset: () => {
                    requests.length = 0;
                },
            });
        });
    });
}
