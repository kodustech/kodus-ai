/**
 * Analytics reads run on the replica set member tagged `workload=analytics`,
 * not on the primary that serves reviews and webhooks; ordinary reads stay on
 * the primary.
 *
 * Needs a REAL replica set with a member tagged `workload: analytics`, so it
 * only runs when MONGO_RS_IT_URI points at one, e.g.
 * `mongodb://localhost:27101,localhost:27102/?replicaSet=rs0`. Skipped
 * otherwise: a standalone ignores read preferences and proves nothing.
 * The command monitor records which member received each read.
 */
import mongoose, { Connection, Schema } from 'mongoose';

import {
    ObservabilityTelemetryModel,
    ObservabilityTelemetryModelSchema,
} from '@libs/analytics/infrastructure/adapters/repositories/schemas/observabilityTelemetry.model';
import { TokenUsageRepository } from '@libs/analytics/infrastructure/adapters/repositories/tokenUsage.repository';

import {
    ANALYTICS_QUERY_READ,
    ANALYTICS_READ_PREFERENCE,
} from './read-preference';

const TEST_DB = 'kodus_read_preference_it';
// Needs a replica set with a secondary tagged workload=analytics, which CI
// does not start: reported as skipped, not passed, without MONGO_RS_IT_URI.
const uri = process.env.MONGO_RS_IT_URI;

(uri ? describe : describe.skip)(
    'analytics read preference (real replica set)',
    () => {
        let connection: Connection;
        let analyticsMember: string;
        let primary: string;
        const servedBy: Array<{
            command: string;
            collection: string;
            address: string;
        }> = [];

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(uri!, {
                    dbName: TEST_DB,
                    monitorCommands: true,
                })
                .asPromise();
            const status: any = await connection
                .db!.admin()
                .command({ replSetGetStatus: 1 });
            const config: any = await connection
                .db!.admin()
                .command({ replSetGetConfig: 1 });
            primary = port(
                status.members.find((m: any) => m.stateStr === 'PRIMARY').name,
            )!;
            analyticsMember = port(
                config.config.members.find(
                    (m: any) => m.tags?.workload === 'analytics',
                ).host,
            )!;
            connection.getClient().on('commandStarted', (event) => {
                servedBy.push({
                    command: event.commandName,
                    collection: String(event.command[event.commandName]),
                    address: event.address,
                });
            });
            await connection.dropDatabase();
            await connection
                .db!.collection('observability_telemetry')
                .insertOne(
                    {
                        attributes: {
                            organizationId: 'org-rs',
                            tu: {
                                isByok: true,
                                sys: false,
                                model: 'm',
                                credentialId: 'c',
                            },
                        },
                        timestamp: new Date('2026-11-10T00:00:00Z'),
                    },
                    { writeConcern: { w: 2 } },
                );
        }, 60_000);

        afterAll(async () => {
            if (!connection) return;
            await connection.dropDatabase();
            await connection.close();
        });

        // The driver reports the address it resolved (`[::1]:27102` for
        // `localhost:27102`), so members are told apart by port.
        const port = (address?: string) => address?.split(':').pop();
        const lastRead = (collection: string, command: string) => {
            const event = [...servedBy]
                .reverse()
                .find(
                    (e) => e.collection === collection && e.command === command,
                );
            return event && { address: port(event.address) };
        };

        it('puts the analytics tag first and any secondary after it', () => {
            expect(ANALYTICS_READ_PREFERENCE.tags).toEqual([
                { workload: 'analytics' },
                {},
            ]);
        });

        it('sends token usage reads to the analytics member', async () => {
            const model = connection.model(
                ObservabilityTelemetryModel.name,
                ObservabilityTelemetryModelSchema,
            );
            const repository = new TokenUsageRepository(
                model as any,
                {} as any,
            );

            await repository.getModelCredentialPairs({
                organizationId: 'org-rs',
                start: new Date('2026-11-01T00:00:00Z'),
                end: new Date('2026-11-30T00:00:00Z'),
                byok: true,
            } as any);

            expect(
                lastRead('observability_telemetry', 'aggregate')?.address,
            ).toBe(analyticsMember);
        });

        it('applies to Mongoose queries, aggregations and the native driver alike', async () => {
            const probe = connection.model(
                'ReadPreferenceProbe',
                new Schema({ n: Number }),
                'read_preference_probe',
            );
            await probe.collection.insertOne(
                { n: 1 },
                { writeConcern: { w: 2 } },
            );

            await probe.find({}).read(ANALYTICS_QUERY_READ).lean().exec();
            expect(lastRead('read_preference_probe', 'find')?.address).toBe(
                analyticsMember,
            );

            await probe
                .aggregate([{ $match: {} }])
                .read(ANALYTICS_READ_PREFERENCE)
                .exec();
            expect(
                lastRead('read_preference_probe', 'aggregate')?.address,
            ).toBe(analyticsMember);

            await probe.collection
                .aggregate([{ $match: {} }], {
                    readPreference: ANALYTICS_READ_PREFERENCE,
                })
                .toArray();
            expect(
                lastRead('read_preference_probe', 'aggregate')?.address,
            ).toBe(analyticsMember);

            // A read that does not ask stays on the primary.
            await probe.find({}).lean().exec();
            expect(lastRead('read_preference_probe', 'find')?.address).toBe(
                primary,
            );
        });
    },
);
