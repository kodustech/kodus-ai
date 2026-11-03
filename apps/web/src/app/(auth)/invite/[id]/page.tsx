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
    params: Promise<{ id: string }>;
}) {
    // The path segment is the sealed invitation token (see the API's
    // invitation-token), not the user id.
    const { id } = await params;
    const token = decodeSegment(id);
    if (!token) return <InviteNotice {...INVALID} />;

    let userData: Awaited<ReturnType<typeof getInviteData>>;
    try {
        userData = await getInviteData(token);
    } catch (error) {
        // Never the error itself: its message carries the URL, token included.
        console.error("Failed to get invite data", {
            statusCode: (error as { statusCode?: number })?.statusCode,
        });
        return <InviteNotice {...UNAVAILABLE} />;
    }

    if (!userData?.uuid || !userData?.email) {
        return <InviteNotice {...INVALID} />;
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
                            inviteToken={token}
                            organizationName={userData.organization?.name}
                        />
                    </Suspense>
                </Page.Content>
            </div>
        </Page.Root>
    );
}

const INVALID = {
    title: "Invalid or expired invitation",
    body: "This invitation link is no longer valid. Please contact your organization administrator for a new invitation.",
};

const UNAVAILABLE = {
    title: "We could not load this invitation",
    body: "Kodus did not answer. Your link may still be valid: try again in a few minutes.",
};

/** The decoded path segment, or null for one that is not valid percent-encoding. */
function decodeSegment(segment: string): string | null {
    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
}

function InviteNotice({ title, body }: { title: string; body: string }) {
    return (
        <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
            <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                <SvgKodus className="h-8" />
                <Heading variant="h2" className="text-center">
                    {title}
                </Heading>
                <p className="text-text-secondary text-center text-sm">
                    {body}
                </p>
            </div>
        </Page.Root>
    );
}
