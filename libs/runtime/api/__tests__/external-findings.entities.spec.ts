import { DataSource } from 'typeorm';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import {
    RuntimeExternalMessageModel,
    RuntimeExternalSubmissionModel,
} from '../infrastructure/runtime-external-finding.models';

it('builds product metadata for both durable external finding tables', async () => {
    const expected = [
        RuntimeExternalMessageModel,
        RuntimeExternalSubmissionModel,
    ];
    const source = new DataSource({
        type: 'postgres',
        entities: ENTITIES.filter((entity) =>
            expected.includes(entity as typeof RuntimeExternalMessageModel),
        ),
    });
    await (
        source as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
    expect(source.getMetadata(RuntimeExternalMessageModel).tableName).toBe(
        'runtime_external_message_keys',
    );
    expect(source.getMetadata(RuntimeExternalSubmissionModel).tableName).toBe(
        'runtime_external_submissions',
    );
});
