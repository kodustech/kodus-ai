import * as http from 'http';

/**
 * Fetches GET /health from the probe HTTP server and parses the response.
 * Uses port 0 so each test gets a free OS-assigned port.
 */
export function getHealth(server: http.Server): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
}> {
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Probe server has no inet address');
    }
    const port = address.port;
    return new Promise((resolve, reject) => {
        const req = http.get(
            `http://127.0.0.1:${port}/health`,
            { timeout: 1000 },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        resolve({
                            statusCode: res.statusCode ?? 0,
                            body: JSON.parse(
                                Buffer.concat(chunks).toString('utf-8'),
                            ),
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
                res.on('error', reject);
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('probe request timed out'));
        });
    });
}

export function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

export async function waitListening(server: http.Server): Promise<void> {
    if (server.listening) return;
    return new Promise((resolve) => server.once('listening', () => resolve()));
}
