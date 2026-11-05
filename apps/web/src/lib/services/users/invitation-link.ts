/**
 * What to tell an owner whose "copy invite link" failed. A 404 means there is
 * no open invitation; anything else is the API not answering, and retrying
 * may work.
 */
export function invitationLinkFailure(error: unknown): {
    title: string;
    description: string;
} {
    const status = (error as { response?: { status?: number } })?.response
        ?.status;
    return status === 404
        ? {
              title: "No open invitation",
              description:
                  "This user has already accepted the invitation or is no longer pending.",
          }
        : {
              title: "Could not get the invite link",
              description: "Try again in a moment.",
          };
}
