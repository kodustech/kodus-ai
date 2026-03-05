"use client";

import { Suspense } from "react";
import { Link } from "@components/ui/link";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { UserRole } from "@enums";
import { useSuspenseAllOrganizationKodyRules } from "@services/kodyRules/hooks";
import { KodyRulesStatus } from "@services/kodyRules/types";
import { Bell } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";

const PendingRulesNotificationContent = () => {
    const { role } = useAuth();

    if (role !== UserRole.OWNER) return null;

    const rules = useSuspenseAllOrganizationKodyRules();
    const pendingRules = rules.filter(
        (rule) => rule.status === KodyRulesStatus.PENDING,
    );

    if (pendingRules.length === 0) return null;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Link href="/settings/code-review/global/kody-rules">
                    <div className="relative flex size-9 items-center justify-center rounded-full text-[#cdcddf] transition-colors hover:bg-[#202032] hover:text-white">
                        <Bell className="size-5" />
                        <div className="absolute top-2 right-2 size-2 rounded-full bg-red-500 ring-2 ring-[#101019]" />
                    </div>
                </Link>
            </TooltipTrigger>
            <TooltipContent>
                <p>You have pending rules to review</p>
            </TooltipContent>
        </Tooltip>
    );
};

export const PendingRulesNotification = () => {
    return (
        <Suspense fallback={null}>
            <PendingRulesNotificationContent />
        </Suspense>
    );
};
