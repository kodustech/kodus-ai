/**
 * Materializes a repo fixture from a test case into a temp directory.
 * Returns the path to the temp directory.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function materializeFixture(repoFixture) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-repo-'));

    for (const [filePath, content] of Object.entries(repoFixture)) {
        const fullPath = path.join(tmpDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
    }

    return tmpDir;
}

function cleanupFixture(tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = { materializeFixture, cleanupFixture };
