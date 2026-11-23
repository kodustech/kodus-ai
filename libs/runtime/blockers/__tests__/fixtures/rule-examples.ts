import type { FailureBundle } from '@libs/runtime/protocol';

import type { BlockerInput } from '../../catalog';

// One input per rule of the blocker classifier, in the registry's order: the
// smallest blocker that rule reads first. Synthetic text only (no customer
// logs). Shared by the pinned-output spec and the per-rule spec.

const AT = '2026-01-01T00:00:00.000Z';

export const bundleOf = (b: Partial<FailureBundle>): FailureBundle => ({
    services: [],
    ports: [],
    disk: [],
    deniedEgress: [],
    redactions: 0,
    truncated: false,
    collectedAt: AT,
    ...b,
});

export interface RuleExample {
    /** The id of the rule that reads it first. */
    rule: string;
    /** What that rule decides, as a behavior sentence. */
    behavior: string;
    /** The card it gives: its kind, its signature and its fixes' ids, in order. */
    card: { kind: string; signature: string; fixes: string[] };
    input: BlockerInput;
}

export const RULE_EXAMPLES: RuleExample[] = [
    {
        rule: 'platform_step',
        behavior: "reads a failed Kodus step as Kodus's own and offers a retry",
        card: { kind: 'platform', signature: 'org_key', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'org_key', message: 'could not fetch the organization key' },
    },
    {
        rule: 'security_violation',
        behavior: 'reads an exfiltration the cell saw as a stopped run with no fix',
        card: { kind: 'security_violation', signature: 'credential_exfiltration', fixes: [] },
        input: { kind: 'security_violation', signature: 'credential_exfiltration', message: 'the test credential went to an unissued host' },
    },
    {
        rule: 'recipe_outdated',
        behavior: "reads a recipe that does not load as the recipe's to fix",
        card: { kind: 'recipe_outdated', signature: 'setup:recipe_outdated', fixes: ['fix_recipe'] },
        input: { kind: 'recipe_outdated', signature: 'setup:recipe_outdated', message: 'yaml: line 3: mapping values are not allowed here' },
    },
    {
        rule: 'recipe_needs',
        behavior: 'reads a recipe that needs other repositories as one a cell does not boot yet',
        card: { kind: 'other_repo', signature: 'recipe_needs', fixes: ['fix_recipe'] },
        input: { kind: 'other_repo', signature: 'recipe_needs', message: 'services.needs names acme/api' },
    },
    {
        rule: 'no_recipe',
        behavior: 'reads a repository with nothing to boot from as a missing recipe',
        card: { kind: 'recipe_outdated', signature: 'setup:no_recipe', fixes: ['fix_recipe'] },
        input: { kind: 'no_recipe', signature: 'setup:no_recipe', message: 'no compose file and no Dockerfile' },
    },
    {
        rule: 'environment_not_prepared',
        behavior: "reads a cell with no prepared image as Kodus's and asks for a new setup",
        card: { kind: 'platform', signature: 'environment_not_prepared', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'environment_not_prepared', message: 'the cell has no prepared image of the environment' },
    },
    {
        rule: 'build_state_evicted',
        behavior: "reads a PR its cell's evicted build cache kept from starting as a platform blocker",
        card: { kind: 'platform', signature: 'build_state_evicted', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'build_state_evicted', message: "the cell removed this environment's build cache to free disk" },
    },
    {
        rule: 'cell_unavailable',
        behavior: 'reads a boot no cell took as a platform blocker',
        card: { kind: 'platform', signature: 'cell_unavailable', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'cell_unavailable', message: 'no cell connected' },
    },
    {
        rule: 'org_capacity',
        behavior: "names the organization's machine cap when the shared cells are full for it",
        card: { kind: 'resources', signature: 'org_capacity', fixes: ['retry_setup', 'use_own_cell'] },
        input: { kind: 'resources', signature: 'org_capacity', message: 'the organization holds every machine it may (cap 4)' },
    },
    {
        rule: 'machine_minutes_exhausted',
        behavior: "reads spent machine minutes as a wait for the day's reset",
        card: { kind: 'resources', signature: 'machine_minutes_exhausted', fixes: ['retry_setup'] },
        input: { kind: 'resources', signature: 'machine_minutes_exhausted', message: 'machine minutes of the day are spent' },
    },
    {
        rule: 'no_capacity',
        behavior: 'reads full cells as a wait, or a cell of your own',
        card: { kind: 'resources', signature: 'no_capacity', fixes: ['retry_setup', 'use_own_cell'] },
        input: { kind: 'resources', signature: 'no_capacity', message: 'every cell is full' },
    },
    {
        rule: 'boot_timeout',
        behavior: "reads a boot past the setup's ceiling as a build to trim",
        card: { kind: 'resources', signature: 'boot_timeout', fixes: ['fix_recipe'] },
        input: { kind: 'resources', signature: 'boot_timeout', message: 'the boot outlived the setup ceiling' },
    },
    {
        rule: 'out_of_memory',
        behavior: 'names the memory limit a build was killed at and offers a larger machine',
        card: { kind: 'resources', signature: 'out_of_memory', fixes: ['bump_machine', 'fix_recipe', 'retry_setup'] },
        input: { kind: 'resources', signature: 'out_of_memory', message: 'the build passed 12288m and was killed' },
    },
    {
        rule: 'builder_failed',
        behavior: "reads a builder that stopped under the build as the cell's",
        card: { kind: 'platform', signature: 'builder_failed', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'builder_failed', message: 'buildkitd exited' },
    },
    {
        rule: 'image_load',
        behavior: 'reads an image the cell could not load as a platform blocker',
        card: { kind: 'platform', signature: 'image_load', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'image_load', message: 'docker load refused the archive' },
    },
    {
        rule: 'image_too_large',
        behavior: 'reads an image larger than a cell keeps as one to make smaller',
        card: { kind: 'resources', signature: 'image_too_large', fixes: ['fix_recipe'] },
        input: { kind: 'resources', signature: 'image_too_large', message: 'image is 40 GB' },
    },
    {
        rule: 'compose_refused',
        behavior: 'reads a compose project the sandbox refused as the recipe to fix',
        card: { kind: 'toolchain', signature: 'compose_refused', fixes: ['fix_recipe'] },
        input: { kind: 'toolchain', signature: 'compose_refused', message: 'privileged: true is not allowed' },
    },
    {
        rule: 'size_unavailable',
        behavior: 'reads a machine size no cell grants as a smaller size to choose',
        card: { kind: 'resources', signature: 'size_unavailable', fixes: ['bump_machine', 'use_own_cell'] },
        input: { kind: 'resources', signature: 'size_unavailable', message: 'asked large, the cell grants medium' },
    },
    {
        rule: 'memory_unavailable',
        behavior: 'reads a Run whose two sides fit no host together as a smaller machine size to choose',
        card: { kind: 'resources', signature: 'memory_unavailable', fixes: ['bump_machine', 'use_own_cell'] },
        input: { kind: 'resources', signature: 'memory_unavailable', message: 'the Run needs 16384 MB for its two sides together' },
    },
    {
        rule: 'isolation_unavailable',
        behavior: 'reads an isolation no cell gives as a capacity blocker',
        card: { kind: 'capacity', signature: 'isolation_unavailable', fixes: ['use_own_cell'] },
        input: { kind: 'capacity', signature: 'isolation_unavailable', message: 'no cell has a microVM backend' },
    },
    {
        rule: 'backend_unavailable',
        behavior: "reads a backend the Run's other side ran on, run by no cell now, as a capacity blocker",
        card: { kind: 'capacity', signature: 'backend_unavailable', fixes: ['retry_setup'] },
        input: { kind: 'capacity', signature: 'backend_unavailable', message: 'no cell runs gvisor now' },
    },
    {
        rule: 'host_unavailable',
        behavior: "reads a Run host the fleet could not start as a capacity blocker to run again",
        card: { kind: 'capacity', signature: 'host_unavailable', fixes: ['retry_setup'] },
        input: { kind: 'capacity', signature: 'host_unavailable', message: 'the host of pool boat-eu-perrun for this Run could not be started (registration_timeout); run it again' },
    },
    {
        rule: 'authored_files_unsupported',
        behavior: "reads a cell too old for Kody's build files as an update to make",
        card: { kind: 'platform', signature: 'authored_files_unsupported', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'authored_files_unsupported', message: 'the cell does not write authored files' },
    },
    {
        rule: 'authored_files',
        behavior: "names the path that kept Kody's build files from being written",
        card: { kind: 'toolchain', signature: 'authored_files', fixes: ['fix_recipe'] },
        input: { kind: 'toolchain', signature: 'authored_files', message: 'authored file .kodus/Dockerfile: the checkout already has it' },
    },
    {
        rule: 'repo_refused',
        behavior: 'names the repository entry the cell refused to unpack',
        card: { kind: 'toolchain', signature: 'repo_refused', fixes: ['fix_recipe'] },
        input: { kind: 'toolchain', signature: 'repo_refused', message: 'refused "repo-abc/web/link": symlink leaves the repository' },
    },
    {
        rule: 'credential',
        behavior: 'reads a registry that answered 401 as a secret to add, not a host to allow',
        card: { kind: 'external_service', signature: 'external_service:credential:npm.example-registry.test', fixes: ['add_secret::npm.example-registry.test'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: 'npm error code E401\nnpm error 401 Unauthorized - GET https://npm.example-registry.test/@acme%2fui - authentication token not provided',
        },
    },
    {
        rule: 'platform_denied',
        behavior: 'reads a host on the Kodus deny list as one no approval opens',
        card: { kind: 'external_service', signature: 'external_service:platform_denied:storage.googleapis.com', fixes: ['use_mirror:storage.googleapis.com'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: 'compose up: exit 1',
            bundle: bundleOf({ deniedEgress: [{ host: 'storage.googleapis.com', port: 443, at: AT, platform: true }] }),
        },
    },
    {
        rule: 'build_egress',
        behavior: "reads a host the image build was denied as the mirror or a build's full access",
        card: { kind: 'external_service', signature: 'external_service:build_egress:registry.npmjs.org', fixes: ['use_mirror:registry.npmjs.org', 'approve_full:registry.npmjs.org'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: '#12 [web 3/5] RUN npm ci\n#12 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
            bundle: bundleOf({ deniedEgress: [{ host: 'registry.npmjs.org', port: 443, at: AT }] }),
        },
    },
    {
        rule: 'egress',
        behavior: 'reads a host the app was denied as one to allow, or a fake',
        card: { kind: 'external_service', signature: 'external_service:egress:api.payments.test', fixes: ['approve_host:api.payments.test', 'use_mock:api.payments.test'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: 'compose up: exit 1',
            bundle: bundleOf({ deniedEgress: [{ host: 'api.payments.test', port: 443, at: AT }] }),
        },
    },
    {
        rule: 'log:lockfile_outdated',
        behavior: 'reads a frozen install that would change the lockfile as a lockfile to commit',
        card: { kind: 'toolchain', signature: 'toolchain:lockfile_outdated:pnpm', fixes: ['fix_recipe'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"' },
    },
    {
        rule: 'log:go_module_not_pinned',
        behavior: "reads a Go module the mirror refused as one missing from go.sum",
        card: { kind: 'toolchain', signature: 'toolchain:go_module_not_pinned:example.test/lib', fixes: ['fix_recipe'] },
        input: { kind: 'unknown', signature: 'compose_up', message: "example.test/lib@v1.2.3 is not pinned by this claim's go.sum" },
    },
    {
        rule: 'log:go_checksum_db',
        behavior: "reads a lookup of the Go checksum database as Kodus's gap",
        card: { kind: 'platform', signature: 'platform:go_checksum_db', fixes: ['retry_setup'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'go: verifying module: example.test/lib@v1.2.3: Get "https://sum.golang.org/lookup": dial tcp: i/o timeout' },
    },
    {
        rule: 'log:ca_untrusted',
        behavior: "reads a build tool that does not trust the cell's certificate as a fix in the Dockerfile, never a retry",
        card: { kind: 'toolchain', signature: 'toolchain:ca_untrusted:bun', fixes: ['trust_cell_ca'] },
        input: {
            kind: 'toolchain',
            signature: 'compose_up',
            message:
                'compose_up: dockergvisor: build api: step [runtime-common 16/17] RUN bun install -g @kodus/kodus-graph@0.3.0 failed:\nerror: UNKNOWN_CERTIFICATE_VERIFICATION_ERROR downloading package manifest @kodus/kodus-graph\nERROR: process "/bin/sh -c bun install -g @kodus/kodus-graph@${KODUS_GRAPH_VERSION}" did not complete successfully: exit code: 1',
        },
    },
    {
        rule: 'log:missing_env',
        behavior: 'names the env var the app asked for and offers a test value through the recipe',
        card: { kind: 'missing_env', signature: 'missing_env:DATABASE_URL', fixes: ['set_env:DATABASE_URL', 'use_mock:DATABASE_URL'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'Error: missing required env var: DATABASE_URL' },
    },
    {
        rule: 'log:invalid_env',
        behavior: "reads the value a service refused at boot as the recipe's to fix, never a retry",
        card: { kind: 'missing_env', signature: 'missing_env:invalid:CODE_MANAGEMENT_SECRET', fixes: ['fix_recipe'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: 'dependency failed to start: container kodus-claim-x-workload-api-1 exited (1)',
            bundle: bundleOf({
                services: [
                    {
                        name: 'api',
                        state: 'exited',
                        logTail: [
                            '/usr/src/app/libs/common/utils/webhooks/webhookTokenCrypto.ts:7',
                            "    throw new Error('CODE_MANAGEMENT_SECRET must be 32 bytes in hexadecimal.');",
                            'Error: CODE_MANAGEMENT_SECRET must be 32 bytes in hexadecimal.',
                            '    at Object../libs/common/utils/webhooks/webhookTokenCrypto.ts (/usr/src/app/libs/common/utils/webhooks/webhookTokenCrypto.ts:7:11)',
                        ],
                    },
                ],
            }),
        },
    },
    {
        rule: 'log:toolchain',
        behavior: 'names the Go version a go.mod asks for',
        card: { kind: 'toolchain', signature: 'toolchain:go', fixes: ['pin_version:go'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'go: go.mod requires go >= 1.23 (running go 1.21)' },
    },
    {
        rule: 'log:native_dep',
        behavior: 'names the header a native build did not find',
        card: { kind: 'native_dep', signature: 'native_dep:libpq-fe.h', fixes: ['add_packages:libpq-fe.h'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'fatal error: libpq-fe.h: No such file or directory' },
    },
    {
        rule: 'log:oom',
        behavior: 'reads a heap out of memory as a machine to enlarge',
        card: { kind: 'resources', signature: 'resources:memory:web', fixes: ['bump_machine', 'retry_setup'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: 'compose up: exit 1',
            bundle: bundleOf({ services: [{ name: 'web', state: 'exited', logTail: ['FATAL ERROR: JavaScript heap out of memory'] }] }),
        },
    },
    {
        rule: 'log:disk',
        behavior: 'reads a full disk as a retry',
        card: { kind: 'resources', signature: 'resources:disk', fixes: ['retry_setup'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'write /var/lib/x: no space left on device' },
    },
    {
        rule: 'log:seed_data',
        behavior: 'reads a missing table as migrations to run in the recipe',
        card: { kind: 'seed_data', signature: 'seed_data:schema', fixes: ['add_seed_step'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'error: relation "users" does not exist' },
    },
    {
        rule: 'log:unreachable',
        behavior: 'reads a refused connection to localhost as a compose service to point at',
        card: { kind: 'external_service', signature: 'external_service:localhost:5432', fixes: ['use_mock:localhost'] },
        input: { kind: 'unknown', signature: 'compose_up', message: 'Error: connect ECONNREFUSED 127.0.0.1:5432' },
    },
    {
        rule: 'not_ready',
        behavior: 'proposes a longer ready check when the app did not answer in time',
        card: { kind: 'not_ready', signature: 'setup:not_ready:app:3000/', fixes: ['raise_health_timeout', 'retry_setup'] },
        input: { kind: 'not_ready', signature: 'setup:not_ready:app:3000/', message: 'the ready check of app:3000/ did not answer after 60 s' },
    },
    {
        rule: 'setup_signature',
        behavior: 'reads a setup step that failed with a known kind as a platform retry',
        card: { kind: 'platform', signature: 'setup:resolve_ref', fixes: ['retry_setup'] },
        input: { kind: 'platform', signature: 'setup:resolve_ref', message: 'could not resolve the default branch' },
    },
    {
        rule: 'recipe_step',
        behavior: "names the recipe step that failed after up as the dev's to fix",
        card: { kind: 'seed_data', signature: 'recipe_migrate', fixes: ['fix_recipe', 'retry_setup'] },
        input: { kind: 'seed_data', signature: 'recipe_migrate', message: 'npm run migrate exited 1' },
    },
    {
        rule: 'service_exited',
        behavior: "reads a service that exited at boot with an error no rule names as the app's own error, quoting it, never a retry",
        card: { kind: 'unknown', signature: 'service_exited:api', fixes: ['read_service_error'] },
        input: {
            kind: 'unknown',
            signature: 'compose_up',
            message: 'dependency failed to start: container kodus-claim-x-workload-api-1 exited (1)',
            bundle: bundleOf({
                services: [
                    {
                        name: 'api',
                        state: 'Exited (1) Less than a second ago',
                        logTail: [
                            '{"level":"warn","time":"2026-11-14T19:49:04.742Z","serviceName":"ResendEmailProvider","msg":"RESEND_API_KEY is not set; email sending is disabled"}',
                            'Stack: TypeError: Cannot read properties of undefined (reading \'toLowerCase\')',
                            '{"level":"info","serviceName":"telemetry","msg":"Telemetry system shutdown complete"}',
                        ],
                    },
                    { name: 'db_postgres', state: 'Up About a minute (healthy)', logTail: ['database system is ready to accept connections'] },
                ],
            }),
        },
    },
    {
        rule: 'fallback',
        behavior: 'keeps a known kind the cell named when no rule read the logs, with a retry',
        card: { kind: 'native_dep', signature: 'compose_up', fixes: ['retry_setup'] },
        input: { kind: 'native_dep', signature: 'compose_up', message: '' },
    },
];

/** More inputs a rule decides, for the branches inside one rule. */
export const BRANCH_EXAMPLES: BlockerInput[] = [
    { kind: 'resources', signature: 'claim_keys', message: 'could not issue keys' },
    { kind: 'unknown', signature: 'org_key', message: 'a platform step under another kind is not a step card' },
    { kind: 'resources', signature: 'org_capacity', message: 'no cap named' },
    { kind: 'resources', signature: 'out_of_memory', message: 'killed with no size' },
    { kind: 'resources', signature: 'out_of_memory', message: 'the build passed 1536m and was killed' },
    { kind: 'toolchain', signature: 'authored_files', message: 'authored file .kodus: not a directory' },
    { kind: 'toolchain', signature: 'authored_files', message: 'the checkout already has it' },
    { kind: 'toolchain', signature: 'repo_refused', message: 'no entry named' },
    {
        kind: 'unknown',
        signature: 'compose_up',
        message: 'npm error code E401',
        bundle: bundleOf({ deniedEgress: [{ host: 'npm.example-registry.test', port: 443, at: AT }] }),
    },
    {
        kind: 'unknown',
        signature: 'compose_up',
        message: 'compose up: exit 1',
        bundle: bundleOf({
            deniedEgress: [
                { host: 'telemetry.nextjs.org', port: 443, at: AT },
                { host: 'fonts.example.test', port: 443, at: '2026-01-01T00:01:00.000Z' },
                { host: 'storage.googleapis.com', port: 443, at: AT, platform: true },
                { host: '1.0.0.10.in-addr.arpa', port: 53, at: AT },
            ],
        }),
    },
    {
        kind: 'unknown',
        signature: 'compose_up',
        message: "E: Temporary failure resolving 'deb.debian.org'",
    },
    {
        kind: 'unknown',
        signature: 'compose_up',
        message: 'error TS2304: Cannot find name x',
        bundle: bundleOf({ deniedEgress: [{ host: 'api.payments.test', port: 443, at: AT }] }),
    },
    { kind: 'unknown', signature: 'compose_up', message: 'npm error engine "node" is incompatible with this module. Expected version "^22.0.0"' },
    { kind: 'unknown', signature: 'compose_up', message: 'ERROR: Package requires a different Python: 3.9.1 not in ">=3.11"' },
    { kind: 'unknown', signature: 'compose_up', message: "Package 'libffi' was not found in the pkg-config search path" },
    { kind: 'unknown', signature: 'compose_up', message: 'gyp ERR! build error' },
    { kind: 'unknown', signature: 'compose_up', message: 'The lockfile would have been modified by this install, which is explicitly forbidden.' },
    { kind: 'unknown', signature: 'compose_up', message: '`npm ci` can only install packages when your package.json and package-lock.json are in sync.' },
    { kind: 'unknown', signature: 'compose_up', message: 'getaddrinfo ENOTFOUND redis' },
    { kind: 'unknown', signature: 'compose_up', message: 'STRIPE_KEY is required' },
    {
        kind: 'not_ready',
        signature: 'setup:not_ready:app:3000/',
        message: 'the ready check did not answer after 60 s',
        bundle: bundleOf({
            ports: [{ service: 'app', port: 3000, listening: false }],
            services: [{ name: 'app', state: 'running', logTail: ['listening on 127.0.0.1:3000'] }],
        }),
    },
    { kind: 'not_ready', signature: 'setup:not_ready:app:3000/', message: "the ready check did not answer after 300 s, when the setup's machine time ran out" },
    { kind: 'not_ready', signature: 'setup:not_ready:app:3000/', message: 'the ready check did not answer after 1200 s' },
    { kind: 'unknown', signature: 'setup:boot', message: 'an unknown kind under a setup signature is not a platform card' },
    { kind: 'toolchain', signature: 'recipe_setup', message: 'pnpm build exited 1' },
    { kind: 'unknown', signature: 'recipe_seed', message: 'seed exited 1' },
    { kind: 'unknown', signature: 'compose_up', message: '' },
    { kind: 'capacity', signature: 'something_else', message: 'a kind the fallback does not keep' },
    { kind: 'unknown', signature: 'boot_failed', message: '', bundle: bundleOf({ services: [{ name: 'api', state: 'exited', logTail: ['panic: nothing'] }] }) },
];
