"use server";

import { PostHog } from "posthog-node";

const posthog = process.env.WEB_POSTHOG_KEY
    ? new PostHog(process.env.WEB_POSTHOG_KEY, {
          host: "https://us.i.posthog.com",
      })
    : null;

export async function capturePostHogEvent(event: {
    userId: string;
    event: string;
    properties?: any;
    /**
     * PostHog groups. Without them an event cannot be counted per
     * organization — the API's events have carried these from the start,
     * and the web's did not, which is why the two could only be joined by
     * hand. `organization` and `team` match the group types the API
     * registers (see libs/telemetry posthog.provider).
     */
    groups?: { organization?: string; team?: string };
}) {
    if (!posthog) return;

    posthog.capture({
        distinctId: event.userId,
        event: event.event,
        properties: event.properties,
        ...(event.groups && {
            groups: Object.fromEntries(
                Object.entries(event.groups).filter(([, v]) => !!v),
            ) as Record<string, string>,
        }),
    });

    // In serverless environments, explicitly flush to ensure the event is sent
    // before the function's execution context is terminated.
    await posthog.flush();
}
