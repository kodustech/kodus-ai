/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    // Pin the tracing root to this app dir so standalone always emits a
    // flat `.next/standalone/server.js`. Without this, Next auto-detects
    // the root by walking up for a lockfile — inside the prod docker build
    // (context = apps/try) that's WORKDIR itself, but on a host build it
    // finds the monorepo root and nests the bundle under apps/try/,
    // breaking the Dockerfile's COPY paths. apps/try has its own yarn.lock
    // and imports nothing from libs/, so the app dir is the correct root.
    outputFileTracingRoot: import.meta.dirname,
    poweredByHeader: false,
    reactStrictMode: true,
    // Pin BUILD_ID to the release so rebuilds of the same source produce
    // identical /_next/static/<hash> paths across replicas (see
    // apps/web/next.config.js for the full rationale). CI passes
    // RELEASE_VERSION via build-arg.
    generateBuildId: async () => {
        return process.env.RELEASE_VERSION || 'dev';
    },
    // The root tsconfig.eslint.json doesn't include apps/try paths, so Next's
    // default lint-during-build fails with parser errors. Skip — tsc still
    // typechecks during build and we can wire a dedicated eslint config later.
    eslint: {
        ignoreDuringBuilds: true,
    },
};

export default nextConfig;
