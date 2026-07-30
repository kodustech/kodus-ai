import type { Metadata } from "next";
import { DM_Sans, Overpass_Mono } from "next/font/google";
import { Toaster } from "@components/ui/toaster/toaster";
import { TooltipProvider } from "@components/ui/tooltip";
import { GoogleTagManager } from "@next/third-parties/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import QueryProvider from "src/core/providers/query.provider";
import { getApiPublicUrl } from "src/core/utils/api-public-url";
import { cn } from "src/core/utils/components";
import { createUrl } from "src/core/utils/helpers";

import { ConfigProvider } from "@providers/ConfigProvider";
import type { PublicConfig } from "@config/publicConfig";

import "./globals.css";

export const dynamic = "force-dynamic";

const dm_sans = DM_Sans({
    subsets: ["latin"],
    preload: true,
});
const overpass_mono = Overpass_Mono({
    subsets: ["latin"],
    preload: true,
});

export const metadata: Metadata = {
    title: {
        default: "Kodus",
        template: "%s | Kodus",
    },
    icons: { icon: "/favicon.ico" },
    robots: {
        index: false,
        follow: false,
        googleBot: { index: false, follow: false, noimageindex: true },
    },
    openGraph: {
        locale: "en_US",
        type: "website",
        siteName: "Kodus",
        title: {
            default: "Kodus",
            template: "%s | Kodus",
        },
    },
};

export default function RootLayout({ children }: React.PropsWithChildren) {
    const publicConfig: PublicConfig = {
        githubInstallUrl: process.env.WEB_GITHUB_INSTALL_URL ?? "",
        bitbucketInstallUrl: process.env.WEB_BITBUCKET_INSTALL_URL ?? "",
        gitlabClientId: process.env.GLOBAL_GITLAB_CLIENT_ID ?? "",
        gitlabRedirectUrl: process.env.GLOBAL_GITLAB_REDIRECT_URL ?? "",
        gitlabScopes: process.env.WEB_GITLAB_SCOPES ?? "",
        gitlabOauthUrl: process.env.WEB_GITLAB_OAUTH_URL ?? "",
        termsAndConditions: process.env.WEB_TERMS_AND_CONDITIONS ?? "",
        supportDocsUrl: process.env.WEB_SUPPORT_DOCS_URL ?? "",
        supportDiscordInviteUrl: process.env.WEB_SUPPORT_DISCORD_INVITE_URL ?? "",
        supportTalkToFounderUrl: process.env.WEB_SUPPORT_TALK_TO_FOUNDER_URL ?? "",
        tokenDocsGithub: process.env.WEB_TOKEN_DOCS_GITHUB ?? "",
        tokenDocsGitlab: process.env.WEB_TOKEN_DOCS_GITLAB ?? "",
        tokenDocsBitbucket: process.env.WEB_TOKEN_DOCS_BITBUCKET ?? "",
        tokenDocsAzureRepos: process.env.WEB_TOKEN_DOCS_AZUREREPOS ?? "",
        tokenDocsForgejo: process.env.WEB_TOKEN_DOCS_FORGEJO ?? "",
        ruleFilesDocs: process.env.WEB_RULE_FILES_DOCS ?? "",
        releaseVersion: process.env.RELEASE_VERSION ?? "",
        nodeEnv: process.env.WEB_NODE_ENV ?? "",
        apiPublicUrl: getApiPublicUrl(),
        helpdeskUrl: process.env.WEB_HOSTNAME_HELPDESK
            ? createUrl(
                  process.env.WEB_HOSTNAME_HELPDESK,
                  process.env.WEB_PORT_HELPDESK,
                  "/auth/cloud",
              )
            : "",
    };

    // Expose publicConfig as window.__KODUS_PUBLIC_CONFIG__ so module-scope
    // client code (e.g. isSelfHosted) can read the runtime config before
    // any React hook fires. Escaping < prevents premature </script>
    // tag closure if a config value ever contains one.
    const configScript =
        "window.__KODUS_PUBLIC_CONFIG__ = " +
        JSON.stringify(publicConfig).replace(/</g, "\\u003c") +
        ";";

    return (
        <html lang="en" className="dark" style={{ colorScheme: "dark" }}>
            <GoogleTagManager gtmId="GTM-T2TMHK7K" />

            <body
                className={cn(
                    "bg-background text-text-primary flex h-screen w-screen flex-col overflow-hidden",
                    overpass_mono.className,
                    dm_sans.className,
                )}>
                <script dangerouslySetInnerHTML={{ __html: configScript }} />
                <ConfigProvider value={publicConfig}>
                    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
                        <QueryProvider>
                            <NuqsAdapter>
                                {children}
                                <Toaster />
                            </NuqsAdapter>
                        </QueryProvider>
                    </TooltipProvider>
                </ConfigProvider>
            </body>
        </html>
    );
}
