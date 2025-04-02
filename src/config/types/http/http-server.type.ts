export type HttpServerConfiguration = {
    host?: string;
    name?: string;
    tz?: string;
    port: number;
    debug?: boolean;
    rateLimit: {
        rateMaxRequest?: number;
        rateInterval?: number;
    };
};
