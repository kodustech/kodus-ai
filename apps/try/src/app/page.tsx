import { redirect } from "next/navigation";

// The public demo no longer ships its own marketing landing — the PR input
// and the "featured PR" grid live on the main Kodus site, which talks to the
// public API directly (POST /cli/public/review-pr, GET /cli/public/featured-reviews).
// This app only renders the review result screen at /r/[jobId]; `/` just
// bounces to the marketing site.
const HOME_REDIRECT = process.env.NEXT_PUBLIC_HOME_REDIRECT ?? "https://kodus.io";

export default function HomePage(): never {
    redirect(HOME_REDIRECT);
}
