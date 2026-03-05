import { Suspense } from "react";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Page } from "@components/ui/page";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import {
    getPlans,
    validateOrganizationLicense,
} from "../_services/billing/fetch";
import type { Plan } from "../_services/billing/types";
import {
    TokenProjectionSection,
    TokenProjectionSkeleton,
} from "./_components/token-projection";
import { fetchPopularModels } from "./_services/models";
import { ChoosePlanPageClient } from "./page.client";

type PlansObject = Record<
    "free" | "teams_byok" | "enterprise",
    Plan | undefined
>;

function organizePlans(plans: Plan[]): PlansObject {
    return plans.reduce((acc, current) => {
        if (current.type === "contact") {
            acc.enterprise = current;
        } else if (current.id === "free_byok") {
            acc.free = current;
        } else if (current.id === "teams_byok") {
            acc.teams_byok = current;
        }
        return acc;
    }, {} as PlansObject);
}

export default async function ChoosePlanPage() {
    const teamId = await getGlobalSelectedTeamId();

    // Fast fetches - these load quickly
    const [plansData, license, simulatorModels] = await Promise.all([
        getPlans().catch(() => ({ plans: [] as Plan[] })),
        validateOrganizationLicense({ teamId }).catch(() => null),
        fetchPopularModels().catch(() => []),
    ]);

    const plansObject = organizePlans(plansData.plans);

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex w-full flex-col gap-1">
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/settings/subscription">
                                    Subscription
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>Choose plan</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <Page.Title className="text-balance">
                        Choose your plan
                    </Page.Title>
                </div>
            </Page.Header>
            <Page.Content>
                <ChoosePlanPageClient
                    plans={plansObject}
                    simulatorModels={simulatorModels}
                    tokenProjectionSlot={
                        <Suspense fallback={<TokenProjectionSkeleton />}>
                            <TokenProjectionSection
                                license={license}
                                simulatorModels={simulatorModels}
                            />
                        </Suspense>
                    }
                />
            </Page.Content>
        </Page.Root>
    );
}
