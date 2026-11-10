import type { Server } from 'http';

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { envSessionKeyFrom } from '@libs/runtime/contracts/env-session';
import { safeFailure } from '@libs/runtime/telemetry/failure';

import { RUNTIME_CONFIG, type WorkerConfig } from '../../shared/config';
import { startEnvSessionServer } from './env-session-server';
import { ENV_SESSION_SERVICE, type EnvSessionService } from './env-session.service';

const SWEEP_MS = 60_000;

/** Starts the env-session listener when RUNTIME_ENV_SESSION_PORT is set, and sweeps idle sessions every minute. */
@Injectable()
export class EnvSessionListener implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger('RuntimeEnvSessions');
    private server?: Server;
    private timer?: NodeJS.Timeout;

    constructor(
        @Inject(RUNTIME_CONFIG) private readonly config: Pick<WorkerConfig, 'envSessionPort' | 'secretSealKey'>,
        @Inject(ENV_SESSION_SERVICE) private readonly sessions: EnvSessionService,
    ) {}

    async onModuleInit() {
        if (!this.config.envSessionPort) {
            this.logger.warn('env-session listener off: RUNTIME_ENV_SESSION_PORT not set (the /mcp/env tools answer 503)');
            return;
        }
        this.server = await startEnvSessionServer({
            service: this.sessions,
            key: envSessionKeyFrom(this.config.secretSealKey),
            port: this.config.envSessionPort,
        });
        this.timer = setInterval(() => {
            this.sessions.sweep().catch((e) => this.logger.warn({ msg: 'env_session.sweep_failed', error: safeFailure(e) }));
        }, SWEEP_MS);
        this.timer.unref();
        this.logger.log(`env-session listener on :${this.config.envSessionPort} (signed by the API only)`);
    }

    async onApplicationShutdown() {
        if (this.timer) clearInterval(this.timer);
        await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    }
}
