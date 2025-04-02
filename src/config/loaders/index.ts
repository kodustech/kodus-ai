import { HttpServerConfiguration } from '@/config/types/http/http-server.type';

export const configLoader = (): ConfigLoader => ({
    server: {
        host: process.env.API_HOST,
        port: parseInt(process.env.API_PORT, 10),
        rateLimit: {
            rateMaxRequest: parseInt(process.env.API_RATE_MAX_REQUEST, 10) || 15,
            rateInterval: parseInt(process.env.API_RATE_INTERVAL, 10) || 30,
        },
    },
});

type ConfigLoader = {
    server: HttpServerConfiguration;
};
