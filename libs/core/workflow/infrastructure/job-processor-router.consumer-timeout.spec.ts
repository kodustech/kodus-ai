/**
 * Config-drift guard for a CODE_REVIEW job outliving the broker's
 * consumer_timeout (issue #1988).
 *
 * The app budget must leave the broker headroom to let the cleanup chain
 * finish (catch -> mark FAILED -> releaseLock -> throw -> republish -> ack)
 * BEFORE RabbitMQ closes the channel with PRECONDITION_FAILED. The broker
 * half of that handshake is `consumer_timeout`.
 *
 * The value is read from the conf actually shipped to self-hosted installs
 * (docker/rabbitMQ/rabbitmq.conf) instead of being restated here, and falls
 * back to RabbitMQ's own default (1800000ms / 30min) when the key is absent.
 * An unset key is exactly the misconfiguration that triggered #1988: the
 * older regression test in job-processor-router.service.spec.ts hardcoded the
 * cloud tfvars value (7200000) and so could never fail for what ships.
 */
import * as fs from 'fs';
import * as path from 'path';

import { CODE_REVIEW_PROCESS_TIMEOUT_MS } from './job-processor-router.service';

/** Headroom the app needs to finish its cleanup chain before the broker acts. */
const REQUIRED_CLEANUP_MARGIN_MS = 5 * 60 * 1000;

/** What RabbitMQ applies when consumer_timeout is not set in the conf. */
const RABBITMQ_DEFAULT_CONSUMER_TIMEOUT_MS = 1800000;

const CONF_RELATIVE_PATH = path.join('docker', 'rabbitMQ', 'rabbitmq.conf');

/** Walk up from __dirname to the repo root (the dir holding package.json). */
function findRepoRoot(startDir: string): string {
    let dir = startDir;

    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }

        const parent = path.dirname(dir);

        if (parent === dir) {
            throw new Error(
                `Could not locate the repo root: no package.json above ${startDir}`,
            );
        }

        dir = parent;
    }
}

const confPath = path.join(findRepoRoot(__dirname), CONF_RELATIVE_PATH);

function readShippedConsumerTimeoutMs(): number {
    const raw = fs.readFileSync(confPath, 'utf8');
    const match = raw.match(/^\s*consumer_timeout\s*=\s*(\d+)\s*$/m);

    return match
        ? Number(match[1])
        : RABBITMQ_DEFAULT_CONSUMER_TIMEOUT_MS;
}

describe('broker consumer_timeout vs app CODE_REVIEW budget', () => {
    it('finds the RabbitMQ conf shipped to self-hosted installs', () => {
        // Without this the assertions below could pass vacuously if the conf
        // is ever moved and every lookup silently degrades to the fallback.
        expect(fs.existsSync(confPath)).toBe(true);
    });

    it('keeps consumer_timeout above the CODE_REVIEW budget plus the cleanup margin', () => {
        const brokerConsumerTimeoutMs = readShippedConsumerTimeoutMs();

        expect(brokerConsumerTimeoutMs).toBeGreaterThan(
            CODE_REVIEW_PROCESS_TIMEOUT_MS,
        );
        expect(brokerConsumerTimeoutMs).toBeGreaterThanOrEqual(
            CODE_REVIEW_PROCESS_TIMEOUT_MS + REQUIRED_CLEANUP_MARGIN_MS,
        );
    });
});
