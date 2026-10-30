/**
 * Zip archive factory for the download endpoints.
 *
 * Exists so the two callers (`ParametersController.downloadCentralizedConfig`
 * and `CliCentralizedConfigController`) share one construction site that a
 * test can reach. They previously each inlined the same call, and both broke
 * the same way when archiver was bumped.
 */
import { ZipArchive } from 'archiver';

/** Matches the compression the download endpoints have always used. */
const ZLIB_LEVEL = 9;

export function createZipArchive(): ZipArchive {
    return new ZipArchive({ zlib: { level: ZLIB_LEVEL } }) as ZipArchive;
}
