import { collectAllRoutes } from './rbac-matrix.shared';

/**
 * In the cloud, the load balancer in front of the API sends every path
 * matching `*\/webhook*` to the webhooks service, which is how
 * `/gitlab/webhook` and the other provider endpoints reach it. An API route
 * whose path contains `/webhook` is caught by the same rule and answers 404
 * from the webhooks service: `/code-management/webhook-failures` did, so the
 * git settings page always showed "Could not load webhook status" and never
 * the repositories left without a webhook. Locally and self-hosted there is no
 * such rule, so only this test catches it.
 */
describe('API routes and the webhook load balancer rule', () => {
    it('finds the controllers routes', () => {
        expect(collectAllRoutes().length).toBeGreaterThan(100);
    });

    it('has no route the */webhook* rule would send to the webhooks service', () => {
        const caught = collectAllRoutes()
            .filter((route) => route.urlPath.includes('/webhook'))
            .map((route) => `${route.httpMethod} ${route.urlPath}`);

        expect(caught).toEqual([]);
    });
});
