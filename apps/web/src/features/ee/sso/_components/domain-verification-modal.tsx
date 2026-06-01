"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import { requestSSODomainVerification } from "@services/ssoConfig/fetch";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";
import { isSelfHosted } from "src/core/utils/self-hosted";

interface DomainVerificationModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domain: string;
    /**
     * Called when the backend auto-verifies the domain (self-hosted mode,
     * `sent: false`). Lets the parent flip the row from Pending → Verified
     * without a page refresh — the cloud flow goes through a separate
     * token-confirmation effect on the page that has its own state update.
     */
    onAutoVerified?: (data: {
        domain: string;
        contactEmail: string;
        verifiedAt: string;
    }) => void;
}

export const DomainVerificationModal = ({
    open,
    onOpenChange,
    domain,
    onAutoVerified,
}: DomainVerificationModalProps) => {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [contactEmail, setContactEmail] = useState("");
    const { organizationName } = useOrganizationContext();

    const handleSubmit = async () => {
        if (!domain) {
            toast({
                title: "Domain required",
                description: "Select a valid domain to verify.",
                variant: "danger",
            });
            return;
        }

        const trimmedContactEmail = contactEmail.trim().toLowerCase();

        if (!trimmedContactEmail) {
            toast({
                title: "Contact email required",
                description:
                    "Provide an email address at this domain to receive the verification link.",
                variant: "danger",
            });
            return;
        }

        setIsSubmitting(true);

        try {
            const result = await requestSSODomainVerification({
                domain,
                contactEmail: trimmedContactEmail,
                organizationName,
            });

            // In self-hosted mode the backend auto-verifies and skips the
            // email handshake (no SaaS email provider required). Surface a
            // different success message so the admin doesn't sit around
            // waiting for an email that was never sent.
            if (result?.sent === false) {
                onAutoVerified?.({
                    domain: result.domain,
                    contactEmail: result.contactEmail,
                    verifiedAt: new Date().toISOString(),
                });
                toast({
                    title: "Domain verified",
                    description: `${domain} is now verified for SSO.`,
                    variant: "success",
                });
            } else {
                toast({
                    title: "Verification email sent",
                    description: `We sent a verification link to ${trimmedContactEmail}.`,
                    variant: "success",
                });
            }
            setContactEmail("");
            onOpenChange(false);
        } catch (error: any) {
            toast({
                title: "Could not send verification email",
                description:
                    error?.response?.data?.message ||
                    "Please check the contact email and try again.",
                variant: "danger",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Verify Enterprise Domain</DialogTitle>
                    <DialogDescription>
                        {isSelfHosted ? (
                            <>
                                Confirm the admin email for{" "}
                                <strong>{domain}</strong>. The domain will be
                                verified immediately — self-hosted deployments
                                skip the email handshake.
                            </>
                        ) : (
                            <>
                                Provide an email from{" "}
                                <strong>{domain}</strong>. We will send a
                                verification link.
                            </>
                        )}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <FormControl.Root>
                        <FormControl.Label>
                            Verification email
                        </FormControl.Label>
                        <Input
                            placeholder={
                                domain ? `admin@${domain}` : "admin@company.com"
                            }
                            value={contactEmail}
                            onChange={(e) => setContactEmail(e.target.value)}
                        />
                    </FormControl.Root>

                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="md"
                            onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="md"
                            disabled={!domain || isSubmitting}
                            loading={isSubmitting}
                            onClick={handleSubmit}>
                            {isSelfHosted ? "Verify domain" : "Send verification email"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};
