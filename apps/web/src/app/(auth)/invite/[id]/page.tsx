import { Suspense } from "react";
import type { Metadata } from "next";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Page } from "@components/ui/page";
import { getInviteData } from "src/lib/auth/fetchers";

import { AcceptInviteForm } from "../../components/invite-form";

export const metadata: Metadata = {
    title: "Accept invite",
};

export default async function InvitePage({
    params,
}: {
    params: { id: string };
}) {
    const { id } = params;
    const userData = await getInviteData(id).catch((error) => {
        console.error(`Failed to get invite data for id ${id}:`, error);
        return null;
    });

    if (!userData?.uuid || !userData?.email) {
        return (
            <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
                <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                    <SvgKodus className="h-8" />
                    <Heading variant="h2" className="text-center">
                        Invalid or expired invitation
                    </Heading>
                    <p className="text-text-secondary text-center text-sm">
                        This invitation link is no longer valid. Please contact
                        your organization administrator for a new invitation.
                    </p>
                </div>
            </Page.Root>
        );
    }

    return (
        <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
            <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                <Page.Header className="flex w-full flex-col items-center gap-10">
                    <SvgKodus className="h-8" />

                    <div className="flex flex-col items-center gap-2">
                        <Heading variant="h2" className="text-center">
                            Welcome to Kodus!
                        </Heading>

                        <p className="text-text-secondary text-center text-sm">
                            You've been invited to join{" "}
                            <strong className="text-primary-light">
                                {userData?.organization?.name}
                            </strong>{" "}
                            with email{" "}
                            <strong className="text-primary-light">
                                {userData?.email}
                            </strong>
                            .
                        </p>
                    </div>
                </Page.Header>

                <Page.Content className="flex-none gap-4">
                    <Suspense>
                        <AcceptInviteForm
                            email={userData.email}
                            inviteId={userData.uuid}
                            organizationName={userData.organization?.name}
                        />
                    </Suspense>
                </Page.Content>
            </div>
        </Page.Root>
    );
}
