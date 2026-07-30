"use client";

import { Tabs, TabsList, TabsTrigger } from "@components/ui/tabs";
import { UserIcon, UsersIcon } from "lucide-react";

export type PullRequestsScope = "mine" | "team";

/**
 * The screen wears two hats — a dev's worklist ("My queue", only my PRs) and a
 * lead's team dashboard ("My team", the whole team scope). The role picks the
 * default (see page.client), but either user can flip: the org session only
 * knows owner-vs-contributor, not leader-vs-member, so the switcher — not an
 * inferred role — is the source of truth for which view is shown.
 *
 * Built on the DS `Tabs` (underline) so it reads as first-class navigation,
 * consistent with the rest of the app.
 */
export function PrViewSwitcher({
    value,
    onChange,
}: {
    value: PullRequestsScope;
    onChange: (scope: PullRequestsScope) => void;
}) {
    return (
        <Tabs
            value={value}
            onValueChange={(next) => onChange(next as PullRequestsScope)}>
            <TabsList className="border-b-0">
                <TabsTrigger value="mine">
                    <span className="flex items-center gap-2">
                        <UserIcon className="size-4" />
                        My queue
                    </span>
                </TabsTrigger>
                <TabsTrigger value="team">
                    <span className="flex items-center gap-2">
                        <UsersIcon className="size-4" />
                        My team
                    </span>
                </TabsTrigger>
            </TabsList>
        </Tabs>
    );
}
