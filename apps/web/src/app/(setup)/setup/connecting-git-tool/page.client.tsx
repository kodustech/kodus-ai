"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { SvgAzureRepos } from "@components/ui/icons/SvgAzureRepos";
import { SvgBitbucket } from "@components/ui/icons/SvgBitbucket";
import { SvgForgejo } from "@components/ui/icons/SvgForgejo";
import { SvgGithub } from "@components/ui/icons/SvgGithub";
import { SvgGitlab } from "@components/ui/icons/SvgGitlab";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { Separator } from "@components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { GIT_INTEGRATIONS_KEY } from "@enums";
import { CheckCircle2, ExternalLink } from "lucide-react";
import integrationFactory from "src/core/integrations/integrationFactory";
import { useAuth } from "src/core/providers/auth.provider";
import { useConfig } from "@providers/ConfigProvider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { ClientSideCookieHelpers } from "src/core/utils/cookie";

import { StepIndicators } from "../_components/step-indicators";
import { useGoToStep } from "../_hooks/use-goto-step";
import { AzureReposTokenModal } from "./_components/modals/azure-repos";
import { BitbucketTokenModal } from "./_components/modals/bitbucket";
import { ForgejoTokenModal } from "./_components/modals/forgejo";
import { GithubTokenModal } from "./_components/modals/github";
import { GitlabTokenModal } from "./_components/modals/gitlab";

export function SetupConnectingGitToolPage(props: {
    githubEnterpriseServerPatEnabled: boolean;
}) {
    useGoToStep();

    const router = useRouter();
    const pathname = usePathname();
    const cfg = useConfig();
    const { teamId } = useSelectedTeamId();
    const { userId, email } = useAuth();
    const nextStepPath = "/setup/choosing-repositories";

    const connectOauthIntegration = async (
        key: (typeof GIT_INTEGRATIONS_KEY)[keyof typeof GIT_INTEGRATIONS_KEY],
    ) => {
        try {
            ClientSideCookieHelpers("started-setup-from-new-setup-page").set(
                "true",
            );

            await integrationFactory.getConnector(key, cfg)?.connect(false, {
                push: router.push,
                pathname,
            });
        } catch (error) {
            console.error(error);
        }
    };

    return (
        <Page.Root className="mx-auto flex h-full min-h-[calc(100vh-4rem)] w-full flex-row overflow-hidden p-6">
            <div className="bg-card-lv1 flex flex-10 flex-col justify-center gap-10 rounded-3xl p-12">
                <div className="flex flex-1 flex-col justify-center gap-10">
                    <Heading variant="h1" className="max-w-60 text-[4vh]">
                        Security and Privacy
                    </Heading>

                    <div className="flex flex-col gap-2">
                        <div className="bg-card-lv2 flex items-center gap-4 rounded-2xl border px-6 py-4 text-sm">
                            <CheckCircle2 />
                            <p>No code stored</p>
                        </div>

                        <div className="bg-card-lv2 flex items-center gap-4 rounded-2xl border px-6 py-4 text-sm">
                            <CheckCircle2 />
                            <p>Full privacy</p>
                        </div>

                        <div className="bg-card-lv2 flex items-center gap-4 rounded-2xl border px-6 py-4 text-sm">
                            <CheckCircle2 />
                            <p>No AI training</p>
                        </div>
                    </div>

                    <div className="bg-card-lv2 text-text-secondary flex max-w-96 flex-col gap-4 rounded-2xl border px-6 py-5 text-sm">
                        <p>
                            One of our clients{" "}
                            <strong className="text-white">
                                reduced PR cycle time
                            </strong>{" "}
                            by <strong className="text-white">50%</strong>,
                            delivering features{" "}
                            <strong className="text-white">2x faster</strong>.
                        </p>
                        <p>What could that mean for your team?</p>
                    </div>
                </div>
            </div>

            <div className="flex flex-14 flex-col items-center justify-center gap-20 p-10">
                <div className="flex max-w-fit flex-1 flex-col justify-center gap-10">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-2">
                        <Heading variant="h2">Connect your Git tool</Heading>

                        <p className="text-text-secondary text-sm">
                            By connecting, Kody starts automating reviews
                            instantly, saving hours every week.
                        </p>
                    </div>

                    <Tabs
                        defaultValue={GIT_INTEGRATIONS_KEY.GITHUB}
                        className="w-full">
                        <TabsList className="mb-4">
                            <TabsTrigger value={GIT_INTEGRATIONS_KEY.GITHUB}>
                                <div className="flex flex-row items-center gap-2">
                                    <SvgGithub className="size-5" />
                                    Github
                                </div>
                            </TabsTrigger>

                            <TabsTrigger value={GIT_INTEGRATIONS_KEY.GITLAB}>
                                <div className="flex flex-row items-center gap-2">
                                    <SvgGitlab className="size-5" />
                                    Gitlab
                                </div>
                            </TabsTrigger>

                            <TabsTrigger value={GIT_INTEGRATIONS_KEY.BITBUCKET}>
                                <div className="flex flex-row items-center gap-2">
                                    <SvgBitbucket className="size-5" />
                                    Bitbucket
                                </div>
                            </TabsTrigger>
                            <TabsTrigger
                                value={GIT_INTEGRATIONS_KEY.AZURE_REPOS}>
                                <div className="flex flex-row items-center gap-2">
                                    <SvgAzureRepos className="size-5" />
                                    Azure Repos
                                </div>
                            </TabsTrigger>
                            <TabsTrigger value={GIT_INTEGRATIONS_KEY.FORGEJO}>
                                <div className="flex flex-row items-center gap-2">
                                    <SvgForgejo className="size-5" />
                                    Forgejo
                                </div>
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent
                            value={GIT_INTEGRATIONS_KEY.GITHUB}
                            className="bg-card-lv1 flex flex-col gap-2 rounded-3xl border p-8">
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                rightIcon={<ExternalLink />}
                                onClick={() =>
                                    connectOauthIntegration(
                                        GIT_INTEGRATIONS_KEY.GITHUB,
                                    )
                                }>
                                Install Github app
                            </Button>

                            <div className="flex flex-row items-center gap-2">
                                <Separator className="flex-1" />
                                <p className="text-text-secondary text-xs">
                                    or
                                </p>
                                <Separator className="flex-1" />
                            </div>

                            <Button
                                size="lg"
                                variant="helper"
                                className="w-full"
                                onClick={async () => {
                                    const response =
                                        await magicModal.show<true>(() => (
                                            <GithubTokenModal
                                                teamId={teamId}
                                                userId={userId!}
                                                userEmail={email}
                                                githubEnterpriseServerPatEnabled={
                                                    props.githubEnterpriseServerPatEnabled
                                                }
                                            />
                                        ));

                                    if (!response) return;

                                    router.push(nextStepPath);
                                }}>
                                Connect via token
                            </Button>
                        </TabsContent>

                        <TabsContent
                            value={GIT_INTEGRATIONS_KEY.GITLAB}
                            className="bg-card-lv1 flex flex-col gap-2 rounded-3xl border p-8">
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                rightIcon={<ExternalLink />}
                                onClick={() =>
                                    connectOauthIntegration(
                                        GIT_INTEGRATIONS_KEY.GITLAB,
                                    )
                                }>
                                Install Gitlab app
                            </Button>

                            <div className="flex flex-row items-center gap-2">
                                <Separator className="flex-1" />
                                <p className="text-text-secondary text-xs">
                                    or
                                </p>
                                <Separator className="flex-1" />
                            </div>

                            <Button
                                size="lg"
                                variant="helper"
                                className="w-full"
                                onClick={async () => {
                                    const response =
                                        await magicModal.show<true>(() => (
                                            <GitlabTokenModal
                                                teamId={teamId}
                                                userId={userId!}
                                                userEmail={email}
                                            />
                                        ));

                                    if (!response) return;

                                    router.push(nextStepPath);
                                }}>
                                Connect via token
                            </Button>
                        </TabsContent>

                        <TabsContent
                            value={GIT_INTEGRATIONS_KEY.BITBUCKET}
                            className="bg-card-lv1 flex flex-col gap-2 rounded-3xl border p-8">
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                onClick={async () => {
                                    const response =
                                        await magicModal.show<true>(() => (
                                            <BitbucketTokenModal
                                                teamId={teamId}
                                                userId={userId!}
                                                userEmail={email}
                                            />
                                        ));

                                    if (!response) return;

                                    router.push(nextStepPath);
                                }}>
                                Connect via token
                            </Button>
                        </TabsContent>

                        <TabsContent
                            value={GIT_INTEGRATIONS_KEY.AZURE_REPOS}
                            className="bg-card-lv1 flex flex-col gap-2 rounded-3xl border p-8">
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                onClick={async () => {
                                    const response =
                                        await magicModal.show<true>(() => (
                                            <AzureReposTokenModal
                                                teamId={teamId}
                                                userId={userId!}
                                                userEmail={email}
                                            />
                                        ));

                                    if (!response) return;

                                    router.push(nextStepPath);
                                }}>
                                Connect via token
                            </Button>
                        </TabsContent>

                        <TabsContent
                            value={GIT_INTEGRATIONS_KEY.FORGEJO}
                            className="bg-card-lv1 flex flex-col gap-2 rounded-3xl border p-8">
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                onClick={async () => {
                                    const response =
                                        await magicModal.show<true>(() => (
                                            <ForgejoTokenModal
                                                teamId={teamId}
                                                userId={userId!}
                                                userEmail={email}
                                            />
                                        ));

                                    if (!response) return;

                                    router.push(nextStepPath);
                                }}>
                                Connect via token
                            </Button>
                        </TabsContent>
                    </Tabs>

                    <p className="text-text-secondary px-4 text-center text-xs">
                        Kody complies with LGPD, GDPR, and CCPA to ensure your
                        privacy and security.
                    </p>
                </div>

                <div className="flex w-full flex-col gap-6">
                    <Separator />

                    <p className="text-text-secondary text-center text-xs">
                        Already trusted by top engineering teams to ship better
                        code faster.
                    </p>

                    <div className="flex flex-row justify-center gap-4 opacity-75">
                        <Image
                            width={40}
                            height={24}
                            alt="r10 logo"
                            className="h-6 w-auto object-contain"
                            src="https://t5y4w6q9.rocketcdn.me/wp-content/uploads/2025/03/r10scrore.png"
                        />

                        <Image
                            width={40}
                            height={24}
                            alt="lerian logo"
                            className="h-6 w-auto object-contain"
                            src="https://t5y4w6q9.rocketcdn.me/wp-content/uploads/2025/03/lerian1-300x182.png"
                        />

                        <Image
                            width={86}
                            height={24}
                            alt="Ikatec logo"
                            className="h-6 w-auto object-contain"
                            src="/assets/images/trusted-by/ikatec.webp"
                        />

                        <Image
                            width={62}
                            height={24}
                            alt="origen logo"
                            className="h-6 w-auto object-contain"
                            src="https://t5y4w6q9.rocketcdn.me/wp-content/uploads/2025/03/origen.png"
                        />

                        <Image
                            width={95}
                            height={24}
                            alt="rocket chat logo"
                            className="h-6 w-[95px] object-contain"
                            src="https://t5y4w6q9.rocketcdn.me/wp-content/uploads/2025/03/rocket-chat-logo.svg"
                        />
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
