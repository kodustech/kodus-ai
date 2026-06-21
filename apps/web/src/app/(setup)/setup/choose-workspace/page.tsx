"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Checkbox } from "@components/ui/checkbox";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Label } from "@components/ui/label";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { useConfig } from "@providers/ConfigProvider";
import { joinOrganization } from "@services/users/fetch";
import { ArrowRight } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import type { AwaitedReturnType } from "src/core/types";
import { getOrganizationsByDomain } from "src/lib/auth/fetchers";

import { StepIndicators } from "../_components/step-indicators";
import { useGoToStep } from "../_hooks/use-goto-step";

export default function ChooseWorkspacePage() {
    const cfg = useConfig();
    useGoToStep();

    const router = useRouter();
    const { userId, email, refreshAccessTokens } = useAuth();
    const domain = email?.split("@")[1];

    const [isLoading, setIsLoading] = useState(true);
    const [matchedOrganizations, setMatchedOrganizations] = useState<
        Array<AwaitedReturnType<typeof getOrganizationsByDomain>[0]>
    >([]);
    const [selectedOrganization, setSelectedOrganization] = useState<
        string | undefined
    >(undefined);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!domain) {
            setIsLoading(false);
            return;
        }

        const getMatchedOrganizations = async () => {
            try {
                const matchedOrganizations =
                    await getOrganizationsByDomain(domain);

                setMatchedOrganizations(matchedOrganizations);
            } catch (error) {
                console.error("Error fetching organizations by domain:", error);
            } finally {
                setIsLoading(false);
            }
        };

        getMatchedOrganizations();
    }, [domain]);

    useEffect(() => {
        if (!isLoading && matchedOrganizations.length === 0) {
            router.push("/setup/creating-workspace");
        }
    }, [isLoading, matchedOrganizations, router]);

    const handleSelectOrganization = (orgId: string) => {
        setSelectedOrganization((current) =>
            current === orgId ? undefined : orgId,
        );
    };

    const handleSubmit = async () => {
        if (!selectedOrganization) return;
        if (!userId) return;

        setIsSubmitting(true);
        try {
            await joinOrganization(userId, selectedOrganization);

            await refreshAccessTokens();

            window.location.href = "/";
        } catch (error) {
            console.error("Failed to update user:", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCreateNew = () => {
        router.push("/setup/creating-workspace");
    };

    if (matchedOrganizations.length === 0) {
        return null;
    }

    const loading = (
        <>
            <div className="flex flex-col gap-2">
                <Heading variant="h2">Verifying some information...</Heading>
                <p className="text-text-secondary text-sm">
                    We are verifying if there are organizations associated with
                    your email domain.
                </p>
            </div>
            <div className="max-h-[30vh] w-full">
                <Spinner />
            </div>
        </>
    );

    const withData = (
        <>
            <div className="flex flex-col gap-2">
                <Heading variant="h2">We found some organizations!</Heading>
                <p className="text-text-secondary text-sm">
                    We found organizations associated with your email domain.
                    Select one to join or create a new organization.
                </p>
            </div>
            <div className="max-h-[30vh] w-full overflow-y-auto">
                <div className="flex h-full w-full flex-col gap-2">
                    {matchedOrganizations.map((org) => (
                        <Card key={org.uuid}>
                            <CardHeader className="flex flex-row items-center gap-3 px-5 py-4">
                                <Checkbox
                                    id={org.uuid}
                                    className="flex-shrink-0 self-center"
                                    checked={selectedOrganization === org.uuid}
                                    onCheckedChange={() =>
                                        handleSelectOrganization(org.uuid)
                                    }
                                />
                                <Label
                                    htmlFor={org.uuid}
                                    className="flex-1 cursor-pointer">
                                    {org.name}
                                </Label>
                            </CardHeader>
                        </Card>
                    ))}
                </div>
            </div>
            <div className="flex flex-col gap-4">
                <Button
                    size="lg"
                    variant="primary"
                    className="w-full"
                    rightIcon={<ArrowRight />}
                    onClick={handleSubmit}
                    disabled={!selectedOrganization || isSubmitting}>
                    Continue
                </Button>
                <Button
                    size="md"
                    variant="secondary"
                    className="w-full"
                    onClick={handleCreateNew}
                    disabled={isSubmitting}>
                    Create a new organization
                </Button>
                <div className="text-text-secondary text-center text-xs">
                    If you don't see your organization,{" "}
                    <Link
                        target="_blank"
                        href={cfg.supportDiscordInviteUrl || ""}>
                        contact support
                    </Link>
                    .
                </div>
            </div>
        </>
    );

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-row p-6">
            <div className="bg-card-lv1 flex flex-10 flex-col justify-center gap-10 rounded-3xl p-12">
                <div className="flex-1 overflow-hidden rounded-3xl">
                    <video
                        loop
                        muted
                        autoPlay
                        playsInline
                        disablePictureInPicture
                        className="h-full w-full object-contain"
                        src="/assets/videos/setup/learn-with-your-context.webm"
                    />
                </div>
            </div>

            <div className="flex flex-14 flex-col justify-center gap-20 p-10">
                <div className="flex flex-col items-center gap-10">
                    <div className="flex max-w-96 flex-col gap-10">
                        <StepIndicators.Auto />

                        {isLoading ? loading : withData}
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
