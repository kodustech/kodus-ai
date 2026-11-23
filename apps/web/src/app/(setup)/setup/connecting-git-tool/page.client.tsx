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
import { useConfig } from "@providers/ConfigProvider";
import { CheckCircle2, ExternalLink } from "lucide-react";
import integrationFactory from "src/core/integrations/integrationFactory";
import { useAuth } from "src/core/providers/auth.provider";
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
        <Page.Root className="mx-auto flex min-h-[calc(100vh-4rem)] w-full flex-col gap-6 p-6 lg:h-full lg:flex-row lg:gap-0 lg:overflow-hidden">
            <div className="bg-card-lv1 hidden flex-10 flex-col justify-center gap-10 rounded-3xl p-12 lg:flex">
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

            <div className="flex flex-col items-center justify-center gap-10 lg:flex-14 lg:gap-20 lg:p-10">
                <div className="flex w-full flex-1 flex-col justify-center gap-10 lg:w-auto lg:max-w-fit">
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
                        <TabsList className="mb-4 h-auto flex-wrap justify-center lg:justify-start">
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

                    <div className="flex flex-row flex-wrap items-center justify-center gap-x-8 gap-y-5 opacity-75">
                        <Image
                            width={126}
                            height={19}
                            alt="Scorpion logo"
                            className="h-[19px] w-auto object-contain"
                            src="/assets/images/trusted-by/scorpion.svg"
                        />

                        <Image
                            width={138}
                            height={25}
                            alt="Cover Genius logo"
                            className="h-[25px] w-auto object-contain"
                            src="/assets/images/trusted-by/cover-genius.svg"
                        />

                        <Image
                            width={64}
                            height={23}
                            alt="Capim logo"
                            className="h-[23px] w-auto object-contain"
                            src="/assets/images/trusted-by/capim.svg"
                        />

                        <Image
                            width={129}
                            height={22}
                            alt="Rocket.Chat logo"
                            className="h-[22px] w-auto object-contain"
                            src="/assets/images/trusted-by/rocket-chat.webp"
                        />
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
