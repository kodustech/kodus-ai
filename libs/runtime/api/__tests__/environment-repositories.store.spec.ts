import { randomUUID } from 'crypto';

import { describeEnvironmentRepositoryStore } from './environment-repositories.contract';
import { InMemoryEnvironmentRepositories } from './fixtures';

describeEnvironmentRepositoryStore('in memory', () => {
    const store = new InMemoryEnvironmentRepositories();
    return {
        store,
        environment: async (organizationId: string) => {
            const environmentId = randomUUID();
            store.environments.push({ environmentId, organizationId });
            return environmentId;
        },
    };
});
