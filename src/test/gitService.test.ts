import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import { checkGitAvailable, parseGitProgress, cloneRepository } from '../core/gitService';

describe('gitService', () => {
  it('detects Git availability on the host system', async () => {
    const git = await checkGitAvailable();
    assert.equal(git.available, true);
    assert.ok(git.version && git.version.includes('git version'));
  });

  it('parses Git progress output lines', () => {
    assert.equal(
      parseGitProgress('remote: Counting objects:  85% (17/20)'),
      'Counting objects:  85% (17/20)'
    );
    assert.equal(
      parseGitProgress('remote: Compressing objects: 100% (12/12)'),
      'Compressing objects: 100% (12/12)'
    );
    assert.equal(
      parseGitProgress('Receiving objects:  45% (45/100), 12.00 KiB | 24.00 KiB/s'),
      'Receiving objects:  45% (45/100), 12.00 KiB | 24.00 KiB/s'
    );
    assert.equal(
      parseGitProgress("Cloning into 'repo'..."),
      'Initializing Git clone...'
    );
    assert.equal(parseGitProgress('   '), null);
  });

  it('handles cancellation signal before cloning starts', async () => {
    const controller = new AbortController();
    controller.abort();

    const dest = path.join(os.tmpdir(), `firstpr-abort-${Date.now()}`);
    await assert.rejects(
      async () => {
        await cloneRepository({
          url: 'https://github.com/facebook/react',
          destPath: dest,
          signal: controller.signal,
        });
      },
      {
        message: /cancelled/i,
      }
    );
  });

  it('fails gracefully when attempting to clone a nonexistent repository', async () => {
    const dest = path.join(os.tmpdir(), `firstpr-nonexistent-${Date.now()}`);
    await assert.rejects(
      async () => {
        await cloneRepository({
          url: 'https://github.com/firstpr-nonexistent-org/this-repo-cannot-exist-12345',
          destPath: dest,
          timeoutMs: 15000,
        });
      },
      (err: Error) => {
        assert.ok(err.message.length > 0);
        return true;
      }
    );
  });
});
