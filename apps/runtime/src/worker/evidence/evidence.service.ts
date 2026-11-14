import type { Server } from 'http';

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';

import { type EvidenceStore, FileEvidenceStore } from '../../shared/evidence/file-evidence-store';
import { startEvidenceServer } from './evidence-server';
import { safeFailure } from '@libs/runtime/telemetry/failure';

export const EVIDENCE_STORE = Symbol('EVIDENCE_STORE');

export interface EvidenceConfig {
    /** RUNTIME_EVIDENCE_STORE: file (this volume and server) or s3 (the bucket; no server, no sweep). */
    store?: 'file' | 's3';
    /** RUNTIME_EVIDENCE_DIR: the local volume of the object store (dev and self-hosted). */
    dir?: string;
    /** RUNTIME_EVIDENCE_PORT: the evidence server's own port (its own origin). */
    port?: number;
    /** RUNTIME_EVIDENCE_SIGNING_SECRET: the HMAC the API signs evidence URLs with, and the worker its upload grants. */
    secret?: string;
    /**
     * RUNTIME_EVIDENCE_UPLOAD_URL: this evidence server as a cell reaches it
     * (https to a DNS name, or http to a local name). Unset: the worker signs
     * no upload grants and a Run's artifacts read "not captured".
     */
    uploadUrl?: string;
}

export const EVIDENCE_CONFIG = Symbol('EVIDENCE_CONFIG');

/**
 * File store: serves the evidence volume (when it has a port and a secret) and
 * applies the 30-day retention. S3 store: nothing to serve (cells and browsers
 * use presigned URLs) and nothing to sweep (the bucket's lifecycle rule).
 */
@Injectable()
export class RuntimeEvidenceService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger('RuntimeEvidence');
    private server?: Server;
    private sweeper?: NodeJS.Timeout;

    constructor(
        @Inject(EVIDENCE_CONFIG) private readonly config: EvidenceConfig,
        @Optional() @Inject(EVIDENCE_STORE) private readonly store?: EvidenceStore | null,
    ) {}

    async onModuleInit() {
        if (!this.store) {
            this.logger.warn('RUNTIME_EVIDENCE_DIR not set: Runs keep no evidence');
            return;
        }
        if (!(this.store instanceof FileEvidenceStore)) {
            this.logger.log('evidence in the S3 bucket: presigned URLs, retention by the bucket lifecycle rule');
            return;
        }
        const files = this.store;
        const sweep = () =>
            files
                .sweep()
                .then((n) => n && this.logger.log(`evidence retention: ${n} object(s) past 30 days removed`))
                .catch((e) => this.logger.warn({ msg: 'evidence.sweep_failed', error: safeFailure(e) }));
        void sweep();
        this.sweeper = setInterval(sweep, 3_600_000);
        this.sweeper.unref?.();
        if (!this.config.port || !this.config.secret) {
            this.logger.warn('evidence server off: RUNTIME_EVIDENCE_PORT and RUNTIME_EVIDENCE_SIGNING_SECRET are both needed');
            return;
        }
        // Cells PUT their artifacts with the worker's upload grants (EVIDENCE-CAPTURE-DESIGN).
        this.server = await startEvidenceServer({ store: files, secret: this.config.secret, port: this.config.port, uploads: true });
        this.logger.log(`evidence server on :${this.config.port} (signed URLs and upload grants only)`);
    }

    async onApplicationShutdown() {
        if (this.sweeper) clearInterval(this.sweeper);
        await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    }
}
