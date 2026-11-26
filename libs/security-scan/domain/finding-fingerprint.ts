import { computeScanFingerprint } from '@libs/issues/domain/scan-fingerprint';

import { ScanFinding, SecurityScanRecord } from './security-scan.types';

/**
 * The issue a scan finding is stored as: the issue it is one more place of
 * (`occurrenceOf`), the one it was folded into when the engine matched it to
 * a stored finding (`storedAs`), else its own identity.
 * Shared with the security-scan eval, so it scores what the job stores.
 */
export function fingerprintOf(
    scan: {
        repository: Pick<
            SecurityScanRecord['repository'],
            'platform' | 'host' | 'id'
        >;
    },
    finding: ScanFinding,
): string {
    if (finding.occurrenceOf) {
        return finding.occurrenceOf;
    }
    if (finding.storedAs) {
        return finding.storedAs;
    }
    return ownFingerprintOf(scan, finding);
}

/**
 * The finding's own identity, whatever issue it is stored under: what a later
 * scan computes when it finds the same place again.
 */
export function ownFingerprintOf(
    scan: {
        repository: Pick<
            SecurityScanRecord['repository'],
            'platform' | 'host' | 'id'
        >;
    },
    finding: ScanFinding,
): string {
    return computeScanFingerprint({
        repositoryPlatform: scan.repository.platform,
        repositoryHost: scan.repository.host ?? '',
        repositoryId: scan.repository.id,
        vulnerabilityClass: finding.vulnerabilityClass,
        filePath: finding.filePath,
        symbol: finding.symbol,
        cwe: finding.cwe,
        appWide: finding.appWide,
    });
}
