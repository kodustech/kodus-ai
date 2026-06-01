"use client";

import { Link } from "@components/ui/link";
import { HelpCircle } from "lucide-react";

import { useConfig } from "@providers/ConfigProvider";

type Provider =
    | "github"
    | "gitlab"
    | "bitbucket"
    | "azure_repos"
    | "forgejo";

// Build the provider → docs URL map from PublicConfig. Was previously a
// module-level const reading process.env at import time (inlined into the
// client bundle). Now it's a hook so the values come from the SSR-
// serialized ConfigProvider and can vary per deployment at runtime.
export function useTokenDocs(): Record<Provider, string> {
    const cfg = useConfig();
    return {
        github: cfg.tokenDocsGithub,
        gitlab: cfg.tokenDocsGitlab,
        bitbucket: cfg.tokenDocsBitbucket,
        azure_repos: cfg.tokenDocsAzureRepos,
        forgejo: cfg.tokenDocsForgejo,
    };
}

export const GitTokenDocs = (props: { provider: Provider }) => {
    const docsLinks = useTokenDocs();
    const link = docsLinks[props.provider];
    if (!link) return null;

    return (
        <div className="mt-4 flex flex-col gap-6">
            <div className="flex flex-row items-center gap-3 text-xs">
                <HelpCircle className="text-alert" />

                <p className="flex flex-col gap-0.5">
                    <span>Questions about configuring the access token?</span>
                    <Link href={link} target="_blank" className="text-xs">
                        Check our documentation
                    </Link>
                </p>
            </div>
        </div>
    );
};
