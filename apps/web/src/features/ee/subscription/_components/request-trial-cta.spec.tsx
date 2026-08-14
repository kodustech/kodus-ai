/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen, waitFor } from "@testing-library/react";

import { RequestTrialCta } from "./request-trial-cta";

jest.mock("src/core/providers/auth.provider", () => ({
    useAuth: () => ({
        email: "dev@acme.com",
        organizationId: "org-123",
    }),
}));

const mockVersion = (body: unknown, ok = true) => {
    global.fetch = jest.fn().mockResolvedValue({
        ok,
        json: async () => body,
    }) as unknown as typeof fetch;
};

describe("RequestTrialCta", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockVersion({ current: "1.4.2" });
    });

    it("links to the trial form with the instance context prefilled", async () => {
        render(<RequestTrialCta />);

        const link = screen.getByRole("link", { name: /request a trial/i });

        await waitFor(() => {
            const url = new URL(link.getAttribute("href")!);
            expect(url.searchParams.get("version")).toBe("1.4.2");
        });

        const url = new URL(link.getAttribute("href")!);
        expect(url.origin + url.pathname).toBe(
            "https://kodus.io/self-hosted-trial",
        );
        expect(url.searchParams.get("org_id")).toBe("org-123");
        expect(url.searchParams.get("email")).toBe("dev@acme.com");
    });

    it("still links out when the version lookup fails", async () => {
        // /api/version reaches out to GitHub — an instance with no egress
        // gets nothing back, and the CTA must survive that.
        global.fetch = jest
            .fn()
            .mockRejectedValue(
                new Error("no egress"),
            ) as unknown as typeof fetch;

        render(<RequestTrialCta />);

        const link = screen.getByRole("link", { name: /request a trial/i });
        expect(link).toHaveAttribute(
            "href",
            "https://kodus.io/self-hosted-trial?org_id=org-123&email=dev%40acme.com",
        );
    });

    it("renders the link as the only action", () => {
        render(<RequestTrialCta />);

        expect(screen.getAllByRole("link")).toHaveLength(1);
        expect(screen.queryByText(/copy/i)).not.toBeInTheDocument();
    });
});
