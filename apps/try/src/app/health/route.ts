// Liveness probe for load balancers / container orchestration. `/` is a
// 307 redirect to the marketing site, which health checks expecting a 200
// would mark unhealthy — this is the guaranteed-200 path.
export function GET(): Response {
    return Response.json({ status: "ok" });
}
