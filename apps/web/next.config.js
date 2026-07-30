const path = require('path');

let withBundleAnalyzer = (config) => config;

if (process.env.ANALYZE === 'true') {
    // Só carrega o bundle analyzer se a variável ANALYZE for 'true'
    withBundleAnalyzer = require('@next/bundle-analyzer')({
        enabled: true,
    });
}

// Pin the project root to the monorepo root so Next/Turbopack can resolve
// `@libs/*` imports (which traverse to `../../libs/*`). Pinning this
// explicitly — instead of letting Next auto-detect via lockfile — keeps
// the protective behavior the previous `outputFileTracingRoot: __dirname`
// gave us: auto-detect walks upward until it finds a pnpm-lock.yaml /
// package.json and was picking up stray files above the repo (e.g. a
// global ~/package.json with language servers), which caused standalone
// to emit `.next/standalone/<full-absolute-path>/` instead of a clean
// `.next/standalone/server.js`. The monorepo root has its own pnpm-lock.yaml
// so this resolves to the same place auto-detect would, but bounded.
//
// Inside the dev docker container, __dirname = /usr/src/app (the
// apps/web bind-mount); '../..' = /usr/, which contains both `src/app/`
// and the new `libs/` mount declared in docker-compose.dev.yml. On the
// host during `next build`, __dirname = <repo>/apps/web; '../..' =
// monorepo root, which contains both apps/web and libs.
const projectRoot = path.resolve(__dirname, '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Emit a self-contained server bundle at .next/standalone so the
    // production image can ship only the files the runtime actually needs
    // (no full node_modules, no devDependencies). Shrinks the web image
    // from ~1GB to ~200MB and reduces supply-chain surface.
    output: 'standalone',
    outputFileTracingRoot: projectRoot,
    // Suppress the default `X-Powered-By: Next.js` response header so
    // self-hosted deployments without an upstream proxy that strips it
    // don't fingerprint the framework version.
    poweredByHeader: false,
    // Pin BUILD_ID to the release / commit SHA so two builds of the same
    // source produce identical chunk hashes. Without this, rebuilding the
    // image at a different time (CI cache miss, replica re-build, etc.)
    // generates different /_next/static/<hash>.js paths, which causes 404s
    // when a load balancer routes requests across replicas built at
    // different moments. CI already passes RELEASE_VERSION via build-arg
    // in every web pipeline.
    generateBuildId: async () => {
        return (
            process.env.RELEASE_VERSION || process.env.GIT_COMMIT_SHA || 'dev'
        );
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    // Turbopack-specific project root. Must match `outputFileTracingRoot`
    // — Next warns and falls back to the latter otherwise.
    turbopack: {
        root: projectRoot,
    },
    // React Compiler (memoização automática). No Next 16 é opção top-level.
    // Ainda roda via `babel-plugin-react-compiler` no 16.2.x (a porta nativa
    // em Rust `experimental.turbopackRustReactCompiler` só existe no canary);
    // migrar para ela quando chegar ao stable elimina o custo de babel (+13s).
    reactCompiler: true,
    experimental: {
        // Tree-shake barrel-heavy packages: import only the icons/helpers a
        // module actually uses instead of pulling the whole package into the
        // chunk. lucide-react is imported in ~223 files; date-fns in ~18;
        // recharts ships a large runtime. Next rewrites these to per-export
        // deep imports at build time.
        optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
        // Cache de filesystem do Turbopack — compila mais rápido entre restarts
        // do dev.
        turbopackFileSystemCacheForDev: true,
        authInterrupts: true,
        staleTimes: {
            dynamic: 300,
            static: 600,
        },
        // Webpack equivalent of the turbopack.root above. Used when
        // `next dev` runs without `--turbopack` (e.g. for production
        // builds via `next build`). Allows imports to traverse outside
        // `apps/web` to the `libs/` sibling.
        externalDir: true,
    },

    // Headers de segurança
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY',
                    },
                    {
                        key: 'Content-Security-Policy',
                        value: "frame-ancestors 'none'",
                    },
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
                    },
                    {
                        key: 'Strict-Transport-Security',
                        value: 'max-age=31536000; includeSubDomains',
                    },
                    {
                        key: 'X-Robots-Tag',
                        value: 'noindex, nofollow',
                    },
                ],
            },
        ];
    },
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'github.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'lh3.googleusercontent.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 't5y4w6q9.rocketcdn.me',
                port: '',
                pathname: '/**',
            },
        ],
    },
    async rewrites() {
        return [
            {
                source: '/setup/teams/configuration',
                destination: '/setup/configuration/teams',
            },
            {
                source: '/teams/:teamId/integrations/teams/configuration',
                destination: '/teams/:teamId/configuration/teams',
            },
            {
                source: '/setup/github/configuration',
                destination: '/setup/configuration/github',
            },
            {
                source: '/setup/gitlab/configuration',
                destination: '/setup/configuration/gitlab',
            },
            {
                source: '/teams/:teamId/integrations/gitlab/configuration',
                destination: '/teams/:teamId/configuration/gitlab',
            },
            {
                source: '/teams/:teamId/integrations/github/configuration',
                destination: '/teams/:teamId/configuration/github',
            },
            {
                source: '/teams/:teamId/integrations/azure-repos/configuration',
                destination: '/teams/:teamId/configuration/azure-repos',
            },
            {
                source: '/setup/azure-repos/configuration',
                destination: '/setup/configuration/azure-repos',
            },
            {
                source: '/setup/bitbucket/configuration',
                destination: '/setup/configuration/bitbucket',
            },
            {
                source: '/teams/:teamId/integrations/bitbucket/configuration',
                destination: '/teams/:teamId/configuration/bitbucket',
            },
        ];
    },
    reactStrictMode: true,
    // env: block removed. Public client-facing values come via
    // ConfigProvider/useConfig() (see waves 1-4). Internal hostnames
    // (WEB_HOSTNAME_API / WEB_PORT_API / WEB_HOSTNAME_BILLING /
    // WEB_PORT_BILLING / WEB_HOSTNAME_MCP_MANAGER / WEB_PORT_MCP_MANAGER
    // and WEB_NODE_ENV) are now read directly from process.env in
    // server-only modules — the client never sees them. Client fetches
    // against the upstream API go through the /api/proxy/api/* route
    // handler introduced in task 7, so build-time inlining is no longer
    // needed at all.
};

module.exports = withBundleAnalyzer(nextConfig);
