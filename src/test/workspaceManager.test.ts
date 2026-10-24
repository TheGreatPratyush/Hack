import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getFirstPrWorkspaceRoot,
  getRepoDestination,
  checkDestination,
  cleanupIncompleteDirectory,
  sanitizeName,
} from '../core/workspaceManager';

describe('workspaceManager', () => {
  const testRoot = path.join(os.tmpdir(), `firstpr-test-ws-${Date.now()}`);

  before(() => {
    fs.mkdirSync(testRoot, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('determines workspace root default under home directory', () => {
    const root = getFirstPrWorkspaceRoot();
    assert.ok(root.endsWith(path.join('FirstPR', 'repositories')));
    assert.ok(root.startsWith(os.homedir()));
  });

  it('sanitizes names containing invalid path characters', () => {
    assert.equal(sanitizeName('owner/with/slashes'), 'owner_with_slashes');
    assert.equal(sanitizeName('cool:project'), 'cool_project');
    assert.equal(sanitizeName('valid-name.123'), 'valid-name.123');
  });

  it('computes safe destination inside workspace root', () => {
    const dest = getRepoDestination('facebook', 'react', testRoot);
    assert.equal(dest, path.join(testRoot, 'facebook-react'));
  });

  it('detects nonexistent destination', () => {
    const nonExistent = path.join(testRoot, 'does-not-exist');
    const res = checkDestination(nonExistent);
    assert.equal(res.exists, false);
    assert.equal(res.isValidGitRepo, false);
  });

  it('detects existing directory without .git', () => {
    const nonGitDir = path.join(testRoot, 'non-git-dir');
    fs.mkdirSync(nonGitDir, { recursive: true });
    const res = checkDestination(nonGitDir);
    assert.equal(res.exists, true);
    assert.equal(res.isValidGitRepo, false);
  });

  it('detects existing directory with valid .git', () => {
    const gitDir = path.join(testRoot, 'valid-git-dir');
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
    const res = checkDestination(gitDir);
    assert.equal(res.exists, true);
    assert.equal(res.isValidGitRepo, true);
  });

  it('cleans up incomplete directory safely within workspace root', () => {
    const tempDir = path.join(testRoot, 'incomplete-clone');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'dummy.txt'), 'test');

    assert.equal(fs.existsSync(tempDir), true);
    const cleaned = cleanupIncompleteDirectory(tempDir, testRoot);
    assert.equal(cleaned, true);
    assert.equal(fs.existsSync(tempDir), false);
  });

  it('refuses to delete directories outside workspace root', () => {
    const outsideDir = path.join(os.tmpdir(), `firstpr-outside-${Date.now()}`);
    fs.mkdirSync(outsideDir, { recursive: true });

    const cleaned = cleanupIncompleteDirectory(outsideDir, testRoot);
    assert.equal(cleaned, false);
    assert.equal(fs.existsSync(outsideDir), true);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
