import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Node's http server drops the promise an async handler returns, so a
 * rejection there is unhandled and stops the process. The listener ends
 * the request instead: a 500 when nothing was written yet, else the socket
 * is closed so the client sees a cut answer, not a whole one.
 */
export function requestListener(
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        // The rejection is ended here, not reported: a handler whose errors must be logged catches them itself.
        handle(req, res).catch(() => {
            if (res.headersSent) return void res.destroy();
            res.writeHead(500).end();
        });
    };
}
