"use server";

import { revalidatePath } from "next/cache";
import { auth } from "src/core/config/auth";

import { assignOrDeassignUserLicense } from "../_services/billing/fetch";

export const assignOrDeassignUserLicenseAction = async ({
    teamId,
    user,
    userName,
}: {
    teamId: string;
    user: {
        git_id: string;
        git_tool: string;
        licenseStatus: "active" | "inactive";
    };
    userName?: string;
}) => {
    const jwtPayload = await auth();

    const result = await assignOrDeassignUserLicense({
        teamId,
        user: {
            gitId: user.git_id,
            gitTool: user.git_tool,
            licenseStatus: user.licenseStatus,
        },
        currentUser: {
            userId: jwtPayload?.user.userId,
            email: jwtPayload?.user.email,
        },
        userName,
    });

    // Refused seats come back as `error` from the billing service but as
    // `failed` from the self-hosted API. Callers only ever saw the former, so
    // a rejected self-hosted assignment read as a success.
    const failures =
        "error" in result ? (result.error ?? []) : (result.failed ?? []);

    revalidatePath("/settings/subscription");

    return { failures, successful: result.successful };
};
