/** A request from the CLI, with the session prefix (`/s/<token>`) already removed. */
export interface IncomingRequest {
    method: string;
    /** Path after the session prefix, query included. */
    path: string;
    headers: Record<string, string>;
    body: Buffer;
}

/** What to send upstream, or an answer the gateway gives itself. */
export type Upstream =
    | { kind: 'forward'; method: string; url: string; headers: Record<string, string>; body: Buffer; modelRequest: boolean }
    | { kind: 'local'; status: number; body: unknown };
