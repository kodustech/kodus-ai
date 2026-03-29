let withBundleAnalyzer = (config) => config;

if (process.env.ANALYZE === "true") {
    // Só carrega o bundle analyzer se a variável ANALYZE for 'true'
    withBundleAnalyzer = require("@next/bundle-analyzer")({
        enabled: true,
    });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
    typescript: {
        ignoreBuildErrors: true,
    },
    eslint: {
        ignoreDuringBuilds: true,
    },
    experimental: {
        authInterrupts: true,
        staleTimes: {
            dynamic: 300,
            static: 600,
        },
    },

    // Headers de segurança
    async headers() {
        return [
            {
                source: "/:path*",
                headers: [
                    {
                        key: "X-Frame-Options",
                        value: "DENY",
                    },
                    {
                        key: "Content-Security-Policy",
                        value: "frame-ancestors 'none'",
                    },
                    {
                        key: "X-Content-Type-Options",
                        value: "nosniff",
                    },
                    {
                        key: "Referrer-Policy",
                        value: "strict-origin-when-cross-origin",
                    },
                    {
                        key: "Permissions-Policy",
                        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
                    },
                    {
                        key: "Strict-Transport-Security",
                        value: "max-age=31536000; includeSubDomains",
                    },
                ],
            },
        ];
    },
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "github.com",
                port: "",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "lh3.googleusercontent.com",
                port: "",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "t5y4w6q9.rocketcdn.me",
                port: "",
                pathname: "/**",
            },
        ],
    },
    async rewrites() {
        return [
            {
                source: "/setup/teams/configuration",
                destination: "/setup/configuration/teams",
            },
            {
                source: "/teams/:teamId/integrations/teams/configuration",
                destination: "/teams/:teamId/configuration/teams",
            },
            {
                source: "/setup/github/configuration",
                destination: "/setup/configuration/github",
            },
            {
                source: "/setup/gitlab/configuration",
                destination: "/setup/configuration/gitlab",
            },
            {
                source: "/teams/:teamId/integrations/gitlab/configuration",
                destination: "/teams/:teamId/configuration/gitlab",
            },
            {
                source: "/teams/:teamId/integrations/github/configuration",
                destination: "/teams/:teamId/configuration/github",
            },
            {
                source: "/teams/:teamId/integrations/azure-repos/configuration",
                destination: "/teams/:teamId/configuration/azure-repos",
            },
            {
                source: "/setup/azure-repos/configuration",
                destination: "/setup/configuration/azure-repos",
            },
            {
                source: "/setup/bitbucket/configuration",
                destination: "/setup/configuration/bitbucket",
            },
            {
                source: "/teams/:teamId/integrations/bitbucket/configuration",
                destination: "/teams/:teamId/configuration/bitbucket",
            },
        ];
    },
    reactStrictMode: true,
    env: {
        WEB_NODE_ENV: process.env.WEB_NODE_ENV,
        WEB_HOSTNAME_API: process.env.WEB_HOSTNAME_API,
        WEB_PORT_API: process.env.WEB_PORT_API,
        WEB_GITHUB_INSTALL_URL: process.env.WEB_GITHUB_INSTALL_URL,
        GLOBAL_GITLAB_CLIENT_ID: process.env.GLOBAL_GITLAB_CLIENT_ID,
        GLOBAL_GITLAB_REDIRECT_URL: process.env.GLOBAL_GITLAB_REDIRECT_URL,
        WEB_GITLAB_SCOPES: process.env.WEB_GITLAB_SCOPES,
        WEB_GITLAB_OAUTH_URL: process.env.WEB_GITLAB_OAUTH_URL,
        WEB_TERMS_AND_CONDITIONS: process.env.WEB_TERMS_AND_CONDITIONS,
        WEB_SUPPORT_DOCS_URL: process.env.WEB_SUPPORT_DOCS_URL,
        WEB_SUPPORT_DISCORD_INVITE_URL:
            process.env.WEB_SUPPORT_DISCORD_INVITE_URL,
        WEB_SUPPORT_TALK_TO_FOUNDER_URL:
            process.env.WEB_SUPPORT_TALK_TO_FOUNDER_URL,
        WEB_BITBUCKET_INSTALL_URL: process.env.WEB_BITBUCKET_INSTALL_URL,
        WEB_HOSTNAME_BILLING: process.env.WEB_HOSTNAME_BILLING,
        WEB_PORT_BILLING: process.env.WEB_PORT_BILLING,
        WEB_TOKEN_DOCS_GITHUB: process.env.WEB_TOKEN_DOCS_GITHUB,
        WEB_TOKEN_DOCS_GITLAB: process.env.WEB_TOKEN_DOCS_GITLAB,
        WEB_TOKEN_DOCS_BITBUCKET: process.env.WEB_TOKEN_DOCS_BITBUCKET,
        WEB_TOKEN_DOCS_AZUREREPOS: process.env.WEB_TOKEN_DOCS_AZUREREPOS,

        WEB_HOSTNAME_MCP_MANAGER: process.env.WEB_HOSTNAME_MCP_MANAGER,
        WEB_PORT_MCP_MANAGER: process.env.WEB_PORT_MCP_MANAGER,
        WEB_RULE_FILES_DOCS: process.env.WEB_RULE_FILES_DOCS,
        RELEASE_VERSION: process.env.RELEASE_VERSION,
    },
};

module.exports = withBundleAnalyzer(nextConfig);
