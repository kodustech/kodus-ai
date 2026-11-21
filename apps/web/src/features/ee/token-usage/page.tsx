import { Page } from "@components/ui/page";
import { isKodyRuntimeReleased } from "src/core/feature-gate/kody-runtime";

import { RuntimeMachinesTab } from "./_components/runtime-machines-tab";
import { UsageTabs } from "./_components/usage-tabs";
import { usageTabFor } from "./_lib/usage-tab";
import { LlmTokensTab } from "./llm-tokens-tab";

/**
 * The organization's Usage screen. Without Kody Runtime released to the org it
 * is the Token Usage screen as it always was; with it, "LLM tokens" and
 * "Runtime machines" tabs, the second reachable by `?tab=runtime`.
 */
export default async function UsagePage({
    searchParams,
}: {
    searchParams: { [key: string]: string | string[] | undefined };
}) {
    const [params, runtimeReleased] = await Promise.all([
        searchParams,
        isKodyRuntimeReleased(),
    ]);

    if (!runtimeReleased) {
        return (
            <Page.Root>
                {/* Full-width like the cockpit (its layout uses the same
                    max-w-full px-6 on header + content). */}
                <Page.Header>
                    <Page.Title>Token Usage</Page.Title>
                </Page.Header>
                <Page.Content>
                    <LlmTokensTab searchParams={params} />
                </Page.Content>
            </Page.Root>
        );
    }

    const tab = usageTabFor(params.tab);
    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>Usage</Page.Title>
            </Page.Header>
            <Page.Content>
                {/* Only the open tab loads: the LLM tab's data fetch is heavy. */}
                <UsageTabs
                    active={tab}
                    llm={<LlmTokensTab searchParams={params} />}
                    runtime={<RuntimeMachinesTab />}
                />
            </Page.Content>
        </Page.Root>
    );
}
