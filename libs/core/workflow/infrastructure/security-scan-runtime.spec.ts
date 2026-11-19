import {
    isSecurityScanSliceProcess,
    SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES,
    SECURITY_SCAN_SLICE_JOB_ID_ENV,
    securityScanSliceJobId,
} from './security-scan-runtime';

describe('security-scan runtime', () => {
    it('treats a set slice job id as a child process', () => {
        expect(
            isSecurityScanSliceProcess({
                [SECURITY_SCAN_SLICE_JOB_ID_ENV]: 'job-1',
            }),
        ).toBe(true);
        expect(isSecurityScanSliceProcess({})).toBe(false);
        expect(
            isSecurityScanSliceProcess({
                [SECURITY_SCAN_SLICE_JOB_ID_ENV]: '',
            }),
        ).toBe(false);
    });

    it('reads the slice job id', () => {
        expect(
            securityScanSliceJobId({
                [SECURITY_SCAN_SLICE_JOB_ID_ENV]: 'job-1',
            }),
        ).toBe('job-1');
        expect(securityScanSliceJobId({})).toBeUndefined();
    });

    it('steals a silent claim in minutes, not a slice lifetime', () => {
        expect(SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES).toBe(3);
        expect(SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES).toBeLessThan(20);
    });
});
