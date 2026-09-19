"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader, CardTitle } from "@components/ui/card";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { ArrowUpCircle } from "lucide-react";
import { pluralize } from "src/core/utils/string";

import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

export const FreeByok = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
    const subscription = useSubscriptionStatus();
    const router = useRouter();
    if (subscription.status !== "free") return null;

    const organizationAdminsCount = members.length;

    const canEdit = usePermission(Action.Update, ResourceType.Billing);

    return (
        <Card className="w-full">
            <CardHeader className="flex flex-row justify-between gap-2">
                <div className="flex flex-col gap-2">
                    <p className="text-text-secondary text-sm">Free (BYOK)</p>
                    <CardTitle className="text-2xl">
                        Community version
                    </CardTitle>

                    <div className="mt-4 flex gap-6">
                        <p className="text-text-secondary text-sm">
                            <strong>{organizationAdminsCount}</strong> workspace{" "}
                            {pluralize(organizationAdminsCount, {
                                singular: "member",
                                plural: "members",
                            })}
                        </p>
                    </div>
                </div>

                <Button
                    size="md"
                    variant="primary"
                    className="h-fit"
                    disabled={!canEdit}
                    leftIcon={<ArrowUpCircle />}
                    onClick={() => router.push("/choose-plan")}>
                    Upgrade
                </Button>
            </CardHeader>
        </Card>
    );
};
