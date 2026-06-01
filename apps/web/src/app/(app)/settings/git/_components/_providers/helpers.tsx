import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { INTEGRATIONS_KEY } from "@enums";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { AuthMode, PlatformType } from "src/core/types";

import { AzureReposModal } from "../_modals/_providers/azure-repos";
import { BitbucketModal } from "../_modals/_providers/bitbucket";
import { ForgejoModal } from "../_modals/_providers/forgejo";
import { GithubModal } from "../_modals/_providers/github";
import { GitlabModal } from "../_modals/_providers/gitlab";

const onSaveToken = async (params: {
    token: string;
    teamId: string;
    username?: string;
    email?: string;
    organizationName?: string;
    selfHostedUrl?: string;
    authMode?: AuthMode;
    integrationKey: INTEGRATIONS_KEY;
    integrationType: PlatformType;
    onSuccess: () => void;
}) => {
    const integrationResponse = await createCodeManagementIntegration({
        integrationType: params.integrationType,
        authMode: params.authMode ?? AuthMode.TOKEN,
        token: params.token,
        host: params.selfHostedUrl,
        username: params.username,
        email: params.email,
        orgName: params.organizationName,
        organizationAndTeamData: {
            teamId: params.teamId,
        },
    });

    switch (integrationResponse.data.status) {
        case "SUCCESS": {
            params.onSuccess();
            break;
        }

        case "NO_ORGANIZATION": {
            toast({
                title: "Integration failed",
                description:
                    "Personal accounts are not supported. Try again with an organization.",
                variant: "danger",
            });
            break;
        }
        case "NO_REPOSITORIES": {
            toast({
                title: "No repositories found",
                description: (
                    <div className="mt-4">
                        <p>Possible reasons:</p>

                        <ul className="list-inside list-disc">
                            <li>No repositories in this account</li>
                            <li>Missing permissions</li>
                        </ul>
                    </div>
                ),
                variant: "danger",
            });
            break;
        }
    }
};

const openBitbucketModal = async (props: {
    teamId: string;
    onSaveToken: () => void;
}) =>
    magicModal.show(() => (
        <BitbucketModal
            onSaveAction={async (
                token,
                username,
                email,
                selfHostedUrl,
                authMode,
            ) => {
                await onSaveToken({
                    token,
                    username,
                    email,
                    selfHostedUrl,
                    authMode,
                    teamId: props.teamId,
                    onSuccess: props.onSaveToken,
                    integrationKey: INTEGRATIONS_KEY.BITBUCKET,
                    integrationType: PlatformType.BITBUCKET,
                });
            }}
        />
    ));

const openAzureReposModal = async (props: {
    teamId: string;
    onSaveToken: () => void;
}) =>
    magicModal.show(() => (
        <AzureReposModal
            onSave={async (token, organizationName) => {
                await onSaveToken({
                    token,
                    organizationName,
                    teamId: props.teamId,
                    onSuccess: props.onSaveToken,
                    integrationKey: INTEGRATIONS_KEY.AZURE_REPOS,
                    integrationType: PlatformType.AZURE_REPOS,
                });
            }}
        />
    ));

const openGithubModal = async (props: {
    teamId: string;
    onGoToOauth: () => void;
    onSaveToken: () => void;
    githubEnterpriseServerPatEnabled: boolean;
}) =>
    magicModal.show(() => (
        <GithubModal
            githubEnterpriseServerPatEnabled={
                props.githubEnterpriseServerPatEnabled
            }
            onGoToOauth={props.onGoToOauth}
            onSaveToken={async (token, selfHostedUrl) => {
                await onSaveToken({
                    token,
                    selfHostedUrl,
                    teamId: props.teamId,
                    integrationType: PlatformType.GITHUB,
                    integrationKey: INTEGRATIONS_KEY.GITHUB,
                    onSuccess: props.onSaveToken,
                });
            }}
        />
    ));

const openForgejoModal = async (props: {
    teamId: string;
    onSaveToken: () => void;
}) =>
    magicModal.show(() => (
        <ForgejoModal
            onSaveToken={async (token, selfHostedUrl) => {
                await onSaveToken({
                    token,
                    selfHostedUrl,
                    teamId: props.teamId,
                    integrationType: PlatformType.FORGEJO,
                    integrationKey: INTEGRATIONS_KEY.FORGEJO,
                    onSuccess: props.onSaveToken,
                });
            }}
        />
    ));

const openGitlabModal = async (props: {
    teamId: string;
    onGoToOauth: () => void;
    onSaveToken: () => void;
}) =>
    magicModal.show(() => (
        <GitlabModal
            onGoToOauth={props.onGoToOauth}
            onSaveToken={async (token, selfHostedUrl) => {
                await onSaveToken({
                    token,
                    selfHostedUrl,
                    teamId: props.teamId,
                    integrationType: PlatformType.GITLAB,
                    integrationKey: INTEGRATIONS_KEY.GITLAB,
                    onSuccess: props.onSaveToken,
                });
            }}
        />
    ));

export const openProviderModal = ({
    onGoToOauth,
    provider,
    teamId,
    onSaveToken,
    githubEnterpriseServerPatEnabled,
}: {
    provider: INTEGRATIONS_KEY;
    teamId: string;
    onGoToOauth: () => void;
    onSaveToken: () => void;
    githubEnterpriseServerPatEnabled: boolean;
}) => {
    switch (provider) {
        case "github":
            return openGithubModal({
                teamId,
                onGoToOauth,
                onSaveToken,
                githubEnterpriseServerPatEnabled,
            });

        case "gitlab":
            return openGitlabModal({ teamId, onGoToOauth, onSaveToken });

        case "bitbucket":
            return openBitbucketModal({ teamId, onSaveToken });

        case "azure_repos":
            return openAzureReposModal({ teamId, onSaveToken });

        case "forgejo":
            return openForgejoModal({ teamId, onSaveToken });
    }
};
