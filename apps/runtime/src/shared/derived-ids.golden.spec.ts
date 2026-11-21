import { claimIdFor } from './claim-id';
import { canonicalAdmissionPayloadHash } from './admission/admission-store';
import { stableStepId } from '../worker/run/step-id';
import { setupCorrelationId } from '../worker/setup/setup-scope';
import { admissionAttemptWorkflowId } from '../worker/dbos/run-engine.service';
import { planReuseKey } from '../worker/run/plan-reuse';
import { setupLearnScopeId } from '@libs/runtime/run/environment-setup';
import { lessonIdFor } from '@libs/runtime/blockers/lessons';
import { environmentPreviewIdFor, previewIdFor } from '@libs/runtime/contracts/preview';
import { memberImageKey, refsDigest } from '@libs/runtime/contracts/workspace';
import { canonicalExternalJSON } from '@libs/runtime/api/domain/external-findings';
import { recipeAuthorCallKey, recipeAuthorFingerprint } from '@libs/runtime/api/application/use-cases/recipe-author.use-case';
import { publishEnvironmentOf } from '@libs/runtime-publish/domain/publish-environment';
import type { AdmissionRef } from './admission/admission-contract';

// Ids, idempotency keys and digests are stored and compared across processes
// and releases (claim rows, DBOS step and workflow ids, lesson rows, preview
// ids, image keys, admission payload hashes). Each value here was computed by
// the release before derive-id.ts; a change to any of them strands what is stored.
const SHA = 'a'.repeat(40);
const TRICKY = { b: [1, undefined, { z: 1, a: null }], a: 'ü\u0000"', é: true, A: 1, u: undefined, n: 1.5e-7 };

describe('derived ids keep the values shipped releases stored', () => {
    it('keeps the claim, step, setup and lesson ids', () => {
        expect(claimIdFor('org-a', 'run-1:head:boot')).toBe('claim-c3db0858b71b47c08a2133e1');
        expect(stableStepId('run-1', 2, 'probe:head:1')).toBe('a3115a78-5901-5c65-9a88-00455c98e19b');
        expect(setupCorrelationId('setup-key-1')).toBe('4dd782c6-783d-48ce-87ec-7a0a85676fc4');
        expect(setupLearnScopeId('setup-key-1')).toBe('a91be10c-c897-458c-80f2-7d081d743bda');
        expect(lessonIdFor('org-a', 'repo-1', 'missing_env:DATABASE_URL', 'fix-1')).toBe('ed7ae236cd36e70d26af24c82f633277');
    });

    it('keeps the preview ids', () => {
        expect(previewIdFor('org-a', 'run-1', 'head' as never)).toBe('prv_dyxes4giwbud4ragzakotquy7d');
        expect(environmentPreviewIdFor('org-a', 'env-1', SHA)).toBe('prv_apfhj3xliucn5iwlhiuxfbdokv');
    });

    it('keeps the admission workflow ids, with and without a repair bucket', () => {
        const ref = (kind: string, key: string) => ({ organizationId: 'org-a', kind, key }) as AdmissionRef;
        expect(admissionAttemptWorkflowId(ref('run', 'k:1'), 3, 4, 2)).toBe('admission:15f4d44379146c9e744639aebde5f88f8def7864a02f9f923549f404ae419cf5:3:4:repair:2');
        expect(admissionAttemptWorkflowId(ref('setup', 'k'), 1, 0)).toBe('admission:130c8cf62cb4d6b3671ae2166b4ef4ea93572ef88c32d580f85d738674510647:1:0');
    });

    it("keeps the recipe author's call key and request fingerprint", () => {
        expect(recipeAuthorCallKey('org-a', 'setup-key-1', 2)).toBe('3d05aba7681ccf1c58319bdf21dbc3f2f1f06c9cbed9b5b95b6d82600f83a554');
        expect(recipeAuthorFingerprint({ sha: SHA })).toBe('80df8f9973a33af77f149164ee126b0da25fd3121e8823362688cf2dc0c78dca');
    });

    it('keeps the workspace digests, the publish environment key and the plan reuse key', () => {
        expect(refsDigest([{ repositoryId: 'repo-b', sha: SHA }, { repositoryId: 'repo-a', sha: 'b'.repeat(40) }], 'sha256:recipe')).toBe(
            'sha256:ea7a621de88e6f79526d152bca04bfcc89938de2283c2a95fb7facc7b3c0cb65',
        );
        expect(memberImageKey('repo-1', SHA, 'sha256:ctx')).toBe('b3b4cd6a6b14bc1fffa9053eb15d28591264d7b49cad7e11b22eb5f5c80d27bc');
        expect(publishEnvironmentOf({ repositoryId: 'repo-2', workspace: [{ repositoryId: 'repo-1', alias: 'web' }] })).toEqual({ key: 'da25bcc6cd52c1f2', name: 'web' });
        const plan = { plannerVersion: 'v1', headSha: SHA, baseSha: 'b'.repeat(40), environmentId: 'env-1', entryPoints: ['b', 'a'], targets: { z: 1, a: [undefined, 2] } };
        expect(planReuseKey(plan)).toBe('9550b9b9b3dbf10511ac2e3a11374a27006f3c9fb80a48104be68ce7d097d860');
    });

    it('encodes the admission payload and external findings in the same canonical JSON', () => {
        const canonical = '{"A":1,"a":"ü\\u0000\\"","b":[1,,{"a":null,"z":1}],"n":1.5e-7,"é":true}';
        expect(canonicalExternalJSON(TRICKY)).toBe(canonical);
        expect(canonicalAdmissionPayloadHash(TRICKY as never)).toBe(require('crypto').createHash('sha256').update(canonical).digest('hex'));
    });
});
