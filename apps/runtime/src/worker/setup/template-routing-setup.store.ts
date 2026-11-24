import { templateSetupKey } from '@libs/runtime/placement/candidate-pools';
import type { EnvironmentSetupProgress, EnvironmentSetupRecord } from '@libs/runtime/run';

import type { EnvironmentSetupStore } from './environment-setup.store';

// An environment TEMPLATE build asks for the environment's setup on its template host (command key
// `template:<org>/<env>:<hostId>`, docs/runtime/host-providers.md §8.2). That setup runs like any other, but its record
// goes to its own store: a template build never changes the environment's state (its one setup record).

/** Where a template setup's record is kept (`PgTemplateSetupStore` fits). */
export interface TemplateSetupRecords {
    get(setupKey: string, organizationId?: string): Promise<EnvironmentSetupRecord | null>;
    save(record: EnvironmentSetupRecord): Promise<void>;
    saveProgress(environmentId: string, key: string, progress: EnvironmentSetupProgress): Promise<void>;
}

/** The org a template command key names, when the key is a template setup's. */
function templateKeyOf(key: string | undefined): string | null {
    if (!key?.startsWith('template:')) return null;
    const org = key.slice('template:'.length).split('/')[0];
    return org ? templateSetupKey(org, key) : null;
}

export class TemplateRoutingSetupStore implements EnvironmentSetupStore {
    constructor(
        private readonly environments: EnvironmentSetupStore,
        private readonly templates: TemplateSetupRecords,
    ) {}

    /** The environment's own record: a template setup starts from it (its lessons, build cell) but never writes it. */
    get(environmentId: string) {
        return this.environments.get(environmentId);
    }

    /** The record of one template setup by its command key (a redelivered command). */
    getTemplate(key: string) {
        return templateKeyOf(key) ? this.templates.get(key) : Promise.resolve(null);
    }

    save(record: EnvironmentSetupRecord) {
        return templateSetupKey(record.organizationId, record.key) ? this.templates.save(record) : this.environments.save(record);
    }

    async saveProgress(environmentId: string, key: string, progress: EnvironmentSetupProgress) {
        if (templateKeyOf(key)) return this.templates.saveProgress(environmentId, key, progress);
        await this.environments.saveProgress?.(environmentId, key, progress);
    }
}
