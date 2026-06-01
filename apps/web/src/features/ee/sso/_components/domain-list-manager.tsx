"use client";

import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { normalizeDomains } from "src/lib/auth/sso-fingerprint";
import { SSODomainVerificationStatusItem } from "src/lib/auth/types";

import { DomainVerificationModal } from "./domain-verification-modal";

interface DomainListManagerProps {
    domains: string[];
    onDomainsChange: (domains: string[]) => void;
    statusByDomain: Record<string, SSODomainVerificationStatusItem>;
    errorMessage?: string;
    hasDomainMismatch: boolean;
    userDomain: string;
    onAutoVerified?: (data: {
        domain: string;
        contactEmail: string;
        verifiedAt: string;
    }) => void;
}

export const DomainListManager = ({
    domains,
    onDomainsChange,
    statusByDomain,
    errorMessage,
    hasDomainMismatch,
    userDomain,
    onAutoVerified,
}: DomainListManagerProps) => {
    const [newDomainValue, setNewDomainValue] = useState("");
    const [domainBeingVerified, setDomainBeingVerified] = useState("");
    const [isDomainModalOpen, setIsDomainModalOpen] = useState(false);

    const normalizedDomains = useMemo(
        () => normalizeDomains(domains || []),
        [domains],
    );

    const openVerifyDomainModal = (domain: string) => {
        setDomainBeingVerified(domain);
        setIsDomainModalOpen(true);
    };

    const closeVerifyDomainModal = (open: boolean) => {
        setIsDomainModalOpen(open);

        if (!open) {
            setDomainBeingVerified("");
        }
    };

    return (
        <>
            <div className="mt-3 space-y-2 rounded-md border p-3">
                {normalizedDomains.map((domain) => {
                    const status = statusByDomain[domain];

                    return (
                        <div key={domain} className="flex items-center gap-2">
                            <Input value={domain} readOnly className="flex-1" />
                            <Badge
                                variant={
                                    status?.verified ? "success" : "in-progress"
                                }>
                                {status?.verified ? "Verified" : "Pending"}
                            </Badge>
                            {!status?.verified && (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                        openVerifyDomainModal(domain)
                                    }>
                                    Verify
                                </Button>
                            )}
                            <Button
                                type="button"
                                variant="secondary"
                                size="icon-sm"
                                onClick={() => {
                                    const nextDomains = normalizeDomains(
                                        normalizedDomains.filter(
                                            (item) => item !== domain,
                                        ),
                                    );

                                    onDomainsChange(nextDomains);
                                }}>
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    );
                })}

                <div className="flex items-center gap-2">
                    <Input
                        placeholder="Add domain (e.g. company.com)"
                        value={newDomainValue}
                        onChange={(event) =>
                            setNewDomainValue(event.target.value)
                        }
                    />
                    <Button
                        type="button"
                        variant="secondary"
                        size="icon-sm"
                        onClick={() => {
                            const newDomain = newDomainValue.trim();

                            if (!newDomain) {
                                return;
                            }

                            onDomainsChange(
                                normalizeDomains([
                                    ...normalizedDomains,
                                    newDomain,
                                ]),
                            );
                            setNewDomainValue("");
                        }}>
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {!!errorMessage && (
                <FormControl.Error>{errorMessage}</FormControl.Error>
            )}

            {hasDomainMismatch && (
                <Alert variant="warning">
                    <AlertCircle />
                    <AlertDescription>
                        Some domains differ from your login domain ({userDomain}
                        ). Make sure these domains belong to your organization.
                    </AlertDescription>
                </Alert>
            )}

            <FormControl.Helper>
                Add one domain per row. Only users with email addresses from
                these domains will be able to sign in via SSO.
            </FormControl.Helper>

            <DomainVerificationModal
                open={isDomainModalOpen}
                onOpenChange={closeVerifyDomainModal}
                domain={domainBeingVerified}
                onAutoVerified={onAutoVerified}
            />
        </>
    );
};
