/**
 * INTEGRATION TEST — the implementation check of a suggestion that groups
 * several locations ("Also found in") stores the locations found fixed with
 * PullRequestsRepository.updateSuggestion. Two checks of one PR can run at
 * once, so a location is added to the stored list, never written over it,
 * and the rest of the check record is written field by field.
 *
 * Requires a running MongoDB — see resolveMongoTestGate.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { Model } from 'mongoose';

import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test');

(shouldSkip ? describe.skip : describe)(
    'PullRequestsRepository — locations of a grouped suggestion',
    () => {
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;
        let module: TestingModule;

        const ORG = 'test-org-suggestion-locations-' + Date.now();
        const org = { organizationId: ORG, teamId: 'team-1' };
        const LOCATIONS = 'implementationCheck.implementedLocations';

        const suggestion = async (id = 's-1') =>
            (await model.collection.findOne({ organizationId: ORG }))?.files
                .flatMap((file: any) => file.suggestions)
                .find((s: any) => s.id === id);

        beforeAll(async () => {
            module = await Test.createTestingModule({
                imports: [
                    ConfigModule.forRoot(),
                    MongooseModule.forRoot(mongoUri),
                    MongooseModule.forFeature([
                        {
                            name: PullRequestsModel.name,
                            schema: PullRequestsSchema,
                        },
                    ]),
                ],
                providers: [PullRequestsRepository],
            }).compile();

            repository = module.get(PullRequestsRepository);
            model = module.get(getModelToken(PullRequestsModel.name));

            await model.collection.insertOne({
                organizationId: ORG,
                number: 1,
                status: 'open',
                provider: 'GITHUB',
                title: 'PR 1',
                repository: { id: 'repo-1', name: 'api' },
                files: [
                    {
                        path: 'app/a.rb',
                        suggestions: [
                            {
                                id: 's-1',
                                relevantFile: 'app/a.rb',
                                implementationStatus:
                                    ImplementationStatus.NOT_IMPLEMENTED,
                            },
                            {
                                id: 's-2',
                                relevantFile: 'app/a.rb',
                                implementationStatus:
                                    ImplementationStatus.NOT_IMPLEMENTED,
                            },
                        ],
                    },
                ],
            });
        });

        afterAll(async () => {
            await model.deleteMany({ organizationId: ORG });
            await module.close();
        });

        it('adds a location to a suggestion with no check record yet, and returns the PR', async () => {
            const pr = await repository.updateSuggestion('s-1', {}, org, {
                addToSet: { [LOCATIONS]: ['app/a.rb:1-2'] },
            });

            expect(
                pr?.files
                    .flatMap((file) => file.suggestions)
                    .find((s) => s.id === 's-1')?.implementationCheck,
            ).toEqual({ implementedLocations: ['app/a.rb:1-2'] });
            expect((await suggestion('s-2'))?.implementationCheck).toBe(
                undefined,
            );
        });

        it('returns only the projected paths of the PR', async () => {
            const pr = await repository.updateSuggestion('s-1', {}, org, {
                addToSet: { [LOCATIONS]: [] },
                projection: [
                    'files.suggestions.id',
                    `files.suggestions.${LOCATIONS}`,
                ],
            });

            expect(pr?.files).toEqual([
                {
                    suggestions: [
                        {
                            id: 's-1',
                            implementationCheck: {
                                implementedLocations: ['app/a.rb:1-2'],
                            },
                        },
                        { id: 's-2' },
                    ],
                },
            ]);
        });

        it('returns the projected paths also when returnDocument is false', async () => {
            const pr = await repository.updateSuggestion('s-2', {}, org, {
                addToSet: { [LOCATIONS]: [] },
                projection: ['files.suggestions.id'],
                returnDocument: false,
            });

            expect(pr?.files).toEqual([
                { suggestions: [{ id: 's-1' }, { id: 's-2' }] },
            ]);
        });

        it('keeps what two checks running at once each add', async () => {
            await Promise.all([
                repository.updateSuggestion('s-1', {}, org, {
                    addToSet: { [LOCATIONS]: ['app/b.rb:10-12'] },
                }),
                repository.updateSuggestion('s-1', {}, org, {
                    addToSet: { [LOCATIONS]: ['app/a.rb:1-2'] },
                }),
                // A check that found nothing fixed adds nothing.
                repository.updateSuggestion('s-1', {}, org, {
                    addToSet: { [LOCATIONS]: [] },
                }),
            ]);

            expect(
                [
                    ...(await suggestion()).implementationCheck
                        .implementedLocations,
                ].sort(),
            ).toEqual(['app/a.rb:1-2', 'app/b.rb:10-12']);
        });

        it('writes the record field by field and drops a stale reason, leaving the locations', async () => {
            await repository.updateSuggestion(
                's-1',
                {
                    'implementationCheck.outcome': 'unmeasured',
                    'implementationCheck.reason': 'llm_error',
                } as any,
                org,
            );
            await repository.updateSuggestion(
                's-1',
                {
                    'implementationCheck.outcome': 'decided',
                    'implementationCheck.verdict':
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                } as any,
                org,
                { unset: ['implementationCheck.reason'] },
            );

            const { implementationCheck } = await suggestion();
            expect(implementationCheck.outcome).toBe('decided');
            expect(implementationCheck.verdict).toBe(
                ImplementationStatus.PARTIALLY_IMPLEMENTED,
            );
            expect(implementationCheck).not.toHaveProperty('reason');
            expect(implementationCheck.implementedLocations).toHaveLength(2);
        });

        it('raises the status under its guard without touching the locations', async () => {
            const raised = await repository.updateSuggestion(
                's-1',
                {
                    'implementationStatus': ImplementationStatus.IMPLEMENTED,
                    'implementationCheck.verdict':
                        ImplementationStatus.IMPLEMENTED,
                } as any,
                org,
                {
                    implementationStatusNotIn: [
                        ImplementationStatus.IMPLEMENTED,
                    ],
                    unset: ['implementationCheck.reason'],
                    returnDocument: false,
                },
            );
            // A second raise matches nothing: the status is already there.
            const again = await repository.updateSuggestion(
                's-1',
                { implementationStatus: ImplementationStatus.IMPLEMENTED },
                org,
                {
                    implementationStatusNotIn: [
                        ImplementationStatus.IMPLEMENTED,
                    ],
                    returnDocument: false,
                },
            );

            expect(raised).not.toBeNull();
            expect(again).toBeNull();
            const stored = await suggestion();
            expect(stored.implementationStatus).toBe(
                ImplementationStatus.IMPLEMENTED,
            );
            expect(
                stored.implementationCheck.implementedLocations,
            ).toHaveLength(2);
        });
    },
);
