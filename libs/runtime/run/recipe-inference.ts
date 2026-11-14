import * as yaml from 'js-yaml';

import { testValueFor } from '@libs/runtime/blockers/catalog';
import type { ExposeKind } from '@libs/runtime/contracts/enums';
import type { RecipeInferenceGap } from '@libs/runtime/contracts/runtime-commands';

import { parseRecipeSummary } from './recipe';

// The first, deterministic step of the learning loop (docs "Ciclo de aprender":
// infer, try, prove, reproduce). With no recipe on the default branch, the
// product reads a few root files at that commit and writes a recipe from their
// structured fields only: compose services, ports, images and healthchecks, the
// Dockerfile's EXPOSE, ENV PORT and HEALTHCHECK, and package.json scripts and
// dependencies. No LLM, no command is invented, no secret is set. Repository
// text never reaches the recipe beyond names and numbers checked here (S-23).

/** The compose files a cell looks for, in its order (apps/runtime-cell/internal/compose DefaultFiles). */
export const INFERENCE_COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const;
export type InferenceComposeFile = (typeof INFERENCE_COMPOSE_FILES)[number];
export const INFERENCE_DOCKERFILE = 'Dockerfile';
export const INFERENCE_PACKAGE_JSON = 'package.json';
/** Each file read for the inference is at most this size. */
export const INFERENCE_MAX_BYTES = 65_536;

export interface InferenceFiles {
    /** The first compose file found, in the cell's order. */
    compose?: { path: InferenceComposeFile; text: string };
    /** The root Dockerfile, when there is one. */
    dockerfile?: string;
    /** The root package.json, read only when there is no compose file. */
    packageJson?: string;
}

export type RecipeInference =
    | {
          status: 'inferred';
          /** The recipe text: deterministic for the same files, so two setups of one commit share its digest. */
          content: string;
          source: 'compose' | 'dockerfile';
          public: string;
          port: number;
          health?: string;
          /** Compose variables given a test value. */
          env: string[];
          /** Required compose variables left out: they look like secrets or control what runs, which a recipe never sets. */
          skippedEnv: string[];
      }
    | { status: 'not_inferred'; reason: RecipeInferenceGap; message: string };

// Compose service names (and what the catalog accepts as one).
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]{0,200}$/;
// The cell refuses these names in services.compose.env (apps/runtime-cell/internal/recipe/validate.go).
export const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)/i;
export const CONTROL_ENV =
    /^(?:PATH|IFS|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GCONV_PATH|(?:LD|DYLD|DOCKER|COMPOSE)_.*)$/i;

/** HTTP ports in the order an app usually listens on them; the earlier wins the public service. */
const HTTP_PORTS = [3000, 8080, 80, 8000, 5000, 4000, 8081, 3001, 8888, 9000, 5173, 4200];
const GRPC_PORTS = new Set([50051]);
/** Ports of infrastructure the probes cannot call as http, and TLS (the observer asks plain http). */
const NOT_HTTP_PORTS = new Set([443, 5432, 3306, 6379, 27017, 5672, 9229, 11211, 2181, 9092]);
const MAX_EXPOSE = 32;

const POSTGRES_IMAGES = new Set(['postgres', 'postgresql', 'postgis', 'timescaledb', 'timescaledb-ha', 'pgvector']);
const MYSQL_IMAGES = new Set(['mysql', 'mariadb', 'percona', 'percona-server']);
/** Infrastructure images: never the app, never exposed as http. */
const INFRA_IMAGES = new Set([
    'redis',
    'valkey',
    'keydb',
    'mongo',
    'mongodb',
    'rabbitmq',
    'memcached',
    'elasticsearch',
    'opensearch',
    'kafka',
    'cp-kafka',
    'zookeeper',
    'minio',
    'localstack',
    'mailhog',
    'mailpit',
    'smtp4dev',
    'nats',
    'etcd',
    'consul',
    'vault',
    'jaeger',
    'all-in-one',
    'otel-collector',
    'opentelemetry-collector',
    'opentelemetry-collector-contrib',
    'prometheus',
    'grafana',
    'adminer',
    'pgadmin4',
    'phpmyadmin',
    'mongo-express',
    'redis-commander',
    'dynamodb-local',
    'azurite',
    'clickhouse-server',
    'cassandra',
    'neo4j',
    'influxdb',
    'wiremock',
    'stripe-mock',
]);
/** Frameworks whose server listens on 3000 when nothing says otherwise. */
const PORT_3000_DEPENDENCIES = ['next', 'nuxt', '@nestjs/core', '@remix-run/serve'];

// Compose files share blocks with anchors and `<<:` merge keys; YAML 1.2 scalars otherwise (`yes` stays a string).
const COMPOSE_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const asPort = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : undefined;
};

/** The container port of one compose `ports` or `expose` entry; udp and ranges are not callable. */
function containerPort(entry: unknown): number | undefined {
    if (isMap(entry)) return entry.protocol === 'udp' ? undefined : asPort(entry.target);
    if (typeof entry === 'number') return asPort(entry);
    if (typeof entry !== 'string') return undefined;
    const [spec, proto] = entry.trim().split('/');
    if (proto && proto !== 'tcp') return undefined;
    // HOST:CONTAINER, IP:HOST:CONTAINER or CONTAINER; the container side is last.
    return asPort(spec.split(':').pop());
}

const portRank = (port: number) => {
    const i = HTTP_PORTS.indexOf(port);
    return i >= 0 ? i : HTTP_PORTS.length + port / 65_536;
};

/** The last path segment of an image reference, without tag or digest: `bitnami/postgresql:15` → `postgresql`. */
const imageBase = (image: unknown) => (typeof image === 'string' ? (image.split('@')[0].split('/').pop() ?? '').split(':')[0].toLowerCase() : '');

/** A local http path in a healthcheck command or Dockerfile HEALTHCHECK, checked as a path. */
function healthPathIn(text: string, port?: number): string | undefined {
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(\/[^\s"'`|;&)]*)?/.exec(text);
    if (!m) return undefined;
    if (port !== undefined && m[1] !== undefined && Number(m[1]) !== port) return undefined;
    const path = m[2] ?? '/';
    return HEALTH_PATH.test(path) ? path : undefined;
}

interface DockerfileFacts {
    ports: number[];
    health?: string;
}

/** EXPOSE, ENV PORT and HEALTHCHECK of the final stage. */
function readDockerfile(text: string): DockerfileFacts {
    const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
    let ports: number[] = [];
    let envPort: number | undefined;
    let health: string | undefined;
    for (const raw of lines) {
        const line = raw.trim();
        const m = /^([A-Za-z]+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const [, instruction, args] = m;
        switch (instruction.toUpperCase()) {
            case 'FROM':
                ports = [];
                envPort = undefined;
                health = undefined;
                break;
            case 'EXPOSE':
                for (const a of args.split(/\s+/)) {
                    const p = containerPort(a);
                    if (p !== undefined && !ports.includes(p)) ports.push(p);
                }
                break;
            case 'ENV': {
                const port = /(?:^|\s)PORT(?:=|\s+)["']?(\d{1,5})["']?(?:\s|$)/.exec(args);
                if (port) envPort = asPort(port[1]);
                break;
            }
            case 'HEALTHCHECK':
                health = /^NONE\b/i.test(args) ? undefined : healthPathIn(args);
                break;
        }
    }
    if (!ports.length && envPort !== undefined) ports = [envPort];
    return { ports, ...(health ? { health } : {}) };
}

/** A port package.json names: `--port 4000`, `-p 4000` or `PORT=4000` in the start script, or a framework that defaults to 3000. */
function packageJsonPort(text: string | undefined): number | undefined {
    if (!text) return undefined;
    let pkg: unknown;
    try {
        pkg = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!isMap(pkg)) return undefined;
    const scripts = isMap(pkg.scripts) ? pkg.scripts : {};
    for (const name of ['start', 'start:prod', 'serve']) {
        const script = scripts[name];
        if (typeof script !== 'string') continue;
        const m = /(?:--port[= ]|\s-p\s+|\bPORT=)(\d{2,5})\b/.exec(script);
        const p = m ? asPort(m[1]) : undefined;
        if (p !== undefined) return p;
    }
    const deps = { ...(isMap(pkg.dependencies) ? pkg.dependencies : {}), ...(isMap(pkg.devDependencies) ? pkg.devDependencies : {}) };
    return PORT_3000_DEPENDENCIES.some((d) => d in deps) ? 3000 : undefined;
}

interface Entry {
    service: string;
    port: number;
    kind: ExposeKind;
}

/** A scalar written so YAML reads it back as the same string (a service named `true` or `1` stays a string). */
const scalar = (s: string) => (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(s) && !/^(?:true|false|yes|no|on|off|null|y|n)$/i.test(s) ? s : JSON.stringify(s));

function render(input: { source: string; composeFile?: string; public: string; health?: string; env: Record<string, string>; expose: Entry[] }): string {
    const lines = [
        `# Kody Runtime recipe (docs §6), inferred by Kodus from ${input.source}.`,
        '# Every value was read from that file; env values are test values and name themselves.',
        'version: 1',
        'services:',
        '  compose:',
        ...(input.composeFile ? [`    files: [${input.composeFile}]`] : []),
        `    public: ${scalar(input.public)}`,
        ...(input.health ? [`    health: ${input.health}`] : []),
    ];
    const names = Object.keys(input.env).sort();
    if (names.length) lines.push('    env:', ...names.map((n) => `      ${n}: ${JSON.stringify(input.env[n])}`));
    lines.push('  expose:', ...input.expose.map((e) => `    - { service: ${scalar(e.service)}, port: ${e.port}, kind: ${e.kind} }`));
    return `${lines.join('\n')}\n`;
}

/** Variables compose refuses to start without (`${VAR:?msg}`, `${VAR?msg}`); `$$` is a literal dollar. */
function requiredComposeVariables(text: string): string[] {
    const names = new Set<string>();
    const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g;
    const unescaped = text.replace(/\$\$/g, '');
    for (let m = re.exec(unescaped); m; m = re.exec(unescaped)) names.add(m[1]);
    return [...names].sort();
}

const notInferred = (reason: RecipeInferenceGap, message: string): RecipeInference => ({ status: 'not_inferred', reason, message });

/** The recipe text, checked by the same parser the setup uses; a recipe Kodus cannot read back is never proposed. */
function finish(r: Extract<RecipeInference, { status: 'inferred' }>): RecipeInference {
    const parsed = parseRecipeSummary(r.content);
    if (!parsed.ok || parsed.recipe.public !== r.public)
        return notInferred('no_http_port', 'Kodus could not write a recipe it can read back from these files.');
    return r;
}

/** Whether a service's volumes bind a path of the repository (./site, ., src/), short or long syntax. */
function mountsRepository(volumes: unknown): boolean {
    if (!Array.isArray(volumes)) return false;
    const local = (src: unknown) => typeof src === 'string' && (src === '.' || src.startsWith('./') || (/^[A-Za-z0-9_][^:]*\//.test(src) && !src.startsWith('/')));
    return volumes.some((v) => (typeof v === 'string' ? local(v.split(':')[0]) : isMap(v) && (v.type === undefined || v.type === 'bind') && local(v.source)));
}

function fromCompose(file: InferenceComposeFile, text: string, dockerfile: DockerfileFacts | undefined): RecipeInference {
    let doc: unknown;
    try {
        doc = yaml.load(text, { schema: COMPOSE_SCHEMA });
    } catch {
        return notInferred('compose_unreadable', `${file} is not YAML Kodus can read, so no recipe was inferred from it.`);
    }
    const services = isMap(doc) && isMap(doc.services) ? doc.services : undefined;
    if (!services || !Object.keys(services).length) return notInferred('compose_unreadable', `${file} has no services, so no recipe was inferred from it.`);

    const databases: Entry[] = [];
    const apps: Array<Entry & { builds: boolean; order: number; health?: string }> = [];
    Object.entries(services).forEach(([name, raw], order) => {
        if (!SERVICE.test(name) || !isMap(raw)) return;
        // A service under a profile does not start with a plain `compose up`.
        if (Array.isArray(raw.profiles) && raw.profiles.length) return;
        const base = imageBase(raw.image);
        if (POSTGRES_IMAGES.has(base)) return void databases.push({ service: name, port: 5432, kind: 'postgres' });
        if (MYSQL_IMAGES.has(base)) return void databases.push({ service: name, port: 3306, kind: 'mysql' });
        if (INFRA_IMAGES.has(base)) return;
        // Runs the repository's code: built from it, or a published image (nginx, a runtime) serving a path of it.
        const builds = raw.build !== undefined || mountsRepository(raw.volumes);
        const buildsRoot =
            raw.build === '.' ||
            raw.build === './' ||
            (isMap(raw.build) &&
                [undefined, '.', './'].includes(raw.build.context as string) &&
                [undefined, 'Dockerfile'].includes(raw.build.dockerfile as string));
        let ports = [...(Array.isArray(raw.ports) ? raw.ports : []), ...(Array.isArray(raw.expose) ? raw.expose : [])]
            .map(containerPort)
            .filter((p): p is number => p !== undefined);
        // A service built from the root Dockerfile with no ports in the compose: the Dockerfile's EXPOSE.
        if (!ports.length && buildsRoot && dockerfile) ports = dockerfile.ports;
        const callable = [...new Set(ports)].filter((p) => !NOT_HTTP_PORTS.has(p));
        const grpc = callable.find((p) => GRPC_PORTS.has(p));
        const http = callable.filter((p) => !GRPC_PORTS.has(p)).sort((a, b) => portRank(a) - portRank(b))[0];
        const hc = isMap(raw.healthcheck) && raw.healthcheck.disable !== true ? raw.healthcheck.test : undefined;
        const hcText = Array.isArray(hc) ? hc.filter((x) => typeof x === 'string').join(' ') : typeof hc === 'string' ? hc : '';
        if (http !== undefined) {
            const health = (hcText && healthPathIn(hcText, http)) || (buildsRoot ? dockerfile?.health : undefined);
            apps.push({ service: name, port: http, kind: 'http', builds, order, ...(health ? { health } : {}) });
        }
        if (grpc !== undefined) apps.push({ service: name, port: grpc, kind: 'grpc', builds, order });
    });

    // The public service: an http service built from the repository first, then the usual app port, then compose order.
    const candidates = apps
        .filter((a) => a.kind === 'http')
        .sort((a, b) => Number(b.builds) - Number(a.builds) || portRank(a.port) - portRank(b.port) || a.order - b.order);
    const pub = candidates[0];
    if (!pub) return notInferred('no_http_port', `No service in ${file} declares an HTTP port Kodus can call (ports or expose), so no recipe was inferred.`);
    // Booting a published image answers the health check without the commit's code: every Run would test the release
    // and report no regressions. Not inferring is the honest answer; a recipe naming a compose file that builds it is the fix.
    if (!pub.builds) {
        return notInferred(
            'published_image',
            `${pub.service} in ${file} runs a published image instead of building the repository, so a pull request's code would never run. Add a recipe that names a compose file (or profile) building it.`,
        );
    }

    const env: Record<string, string> = {};
    const skippedEnv: string[] = [];
    for (const name of requiredComposeVariables(text)) {
        if (!ENV_NAME.test(name) || SECRET_NAME.test(name) || CONTROL_ENV.test(name)) skippedEnv.push(name);
        else env[name] = testValueFor(name);
    }
    const rest = [...apps.filter((a) => a !== pub).sort((a, b) => a.order - b.order), ...databases];
    const expose: Entry[] = [pub, ...rest].slice(0, MAX_EXPOSE).map(({ service, port, kind }) => ({ service, port, kind }));
    return finish({
        status: 'inferred',
        content: render({ source: file, composeFile: file, public: pub.service, ...(pub.health ? { health: pub.health } : {}), env, expose }),
        source: 'compose',
        public: pub.service,
        port: pub.port,
        ...(pub.health ? { health: pub.health } : {}),
        env: Object.keys(env).sort(),
        skippedEnv,
    });
}

/**
 * The recipe Kodus can write from these files, or why it cannot. A compose
 * file wins; with only a Dockerfile the recipe exposes one service, `app`,
 * which is the name the cell gives the one-service project it builds from the
 * Dockerfile (it names it after the first exposed service).
 */
export function inferRecipe(files: InferenceFiles): RecipeInference {
    const dockerfile = files.dockerfile !== undefined ? readDockerfile(files.dockerfile) : undefined;
    if (files.compose) return fromCompose(files.compose.path, files.compose.text, dockerfile);
    if (!dockerfile) {
        return notInferred('no_build_files', 'There is no compose file and no Dockerfile at the repository root, so Kodus has nothing to infer a recipe from.');
    }
    const port = dockerfile.ports.filter((p) => !NOT_HTTP_PORTS.has(p)).sort((a, b) => portRank(a) - portRank(b))[0] ?? packageJsonPort(files.packageJson);
    if (port === undefined) {
        return notInferred(
            'no_http_port',
            'The Dockerfile has no EXPOSE or ENV PORT and package.json names no port, so Kodus cannot tell where the app listens.',
        );
    }
    const fromPackage = !dockerfile.ports.some((p) => p === port);
    return finish({
        status: 'inferred',
        content: render({
            source: fromPackage ? 'Dockerfile and package.json' : 'Dockerfile',
            public: 'app',
            ...(dockerfile.health ? { health: dockerfile.health } : {}),
            env: {},
            expose: [{ service: 'app', port, kind: 'http' }],
        }),
        source: 'dockerfile',
        public: 'app',
        port,
        ...(dockerfile.health ? { health: dockerfile.health } : {}),
        env: [],
        skippedEnv: [],
    });
}
