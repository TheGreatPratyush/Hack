import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateGitHubUrl } from '../core/urlValidator';

describe('validateGitHubUrl', () => {
  it('accepts a valid public GitHub repository URL', () => {
    const res = validateGitHubUrl('https://github.com/facebook/react');
    assert.equal(res.isValid, true);
    if (res.isValid) {
      assert.equal(res.normalizedUrl, 'https://github.com/facebook/react');
      assert.equal(res.owner, 'facebook');
      assert.equal(res.repo, 'react');
      assert.equal(res.message, 'Repository URL validated successfully.');
    }
  });

  it('accepts a valid URL with a trailing slash', () => {
    const res = validateGitHubUrl('https://github.com/vercel/next.js/');
    assert.equal(res.isValid, true);
    if (res.isValid) {
      assert.equal(res.normalizedUrl, 'https://github.com/vercel/next.js');
      assert.equal(res.owner, 'vercel');
      assert.equal(res.repo, 'next.js');
    }
  });

  it('accepts a valid URL with .git suffix and normalizes it', () => {
    const res = validateGitHubUrl('https://github.com/expressjs/express.git');
    assert.equal(res.isValid, true);
    if (res.isValid) {
      assert.equal(res.normalizedUrl, 'https://github.com/expressjs/express');
      assert.equal(res.owner, 'expressjs');
      assert.equal(res.repo, 'express');
    }
  });

  it('accepts a valid URL with www.github.com', () => {
    const res = validateGitHubUrl('https://www.github.com/owner/my-cool-project');
    assert.equal(res.isValid, true);
    if (res.isValid) {
      assert.equal(res.normalizedUrl, 'https://github.com/owner/my-cool-project');
      assert.equal(res.owner, 'owner');
      assert.equal(res.repo, 'my-cool-project');
    }
  });

  it('rejects a non-GitHub host', () => {
    const res = validateGitHubUrl('https://gitlab.com/owner/repo');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /Unsupported host/i);
    }
  });

  it('rejects a URL missing the repository name', () => {
    const res = validateGitHubUrl('https://github.com/facebook');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /missing the repository name/i);
    }
  });

  it('rejects a URL missing both owner and repository', () => {
    const res = validateGitHubUrl('https://github.com/');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /missing/i);
    }
  });

  it('rejects a malformed URL', () => {
    const res = validateGitHubUrl('not-a-url');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /Malformed URL/i);
    }
  });

  it('rejects empty input or whitespace', () => {
    const res1 = validateGitHubUrl('');
    assert.equal(res1.isValid, false);

    const res2 = validateGitHubUrl('   ');
    assert.equal(res2.isValid, false);

    const res3 = validateGitHubUrl(null as unknown as string);
    assert.equal(res3.isValid, false);
  });

  it('rejects input containing shell metacharacters', () => {
    const res = validateGitHubUrl('https://github.com/owner/repo; rm -rf /');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /invalid characters or command syntax/i);
    }
  });

  it('rejects HTTP protocol', () => {
    const res = validateGitHubUrl('http://github.com/owner/repo');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /Only secure HTTPS/i);
    }
  });

  it('rejects deep subpaths (e.g. issues or pulls)', () => {
    const res = validateGitHubUrl('https://github.com/facebook/react/pull/123');
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.match(res.error, /extra subpaths/i);
    }
  });
});
