import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { inspectProject, isPlaceholderTestScript } from '../core/projectInspector';

describe('projectInspector', () => {
  const testRoot = path.join(os.tmpdir(), `firstpr-inspector-test-${Date.now()}`);

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

  it('rejects nonexistent directory gracefully', () => {
    const res = inspectProject(path.join(testRoot, 'does-not-exist'));
    assert.equal(res.isNodeProject, false);
    assert.match(res.error || '', /does not exist/i);
  });

  it('rejects non-directory path', () => {
    const filePath = path.join(testRoot, 'dummy.txt');
    fs.writeFileSync(filePath, 'hello');
    const res = inspectProject(filePath);
    assert.equal(res.isNodeProject, false);
    assert.match(res.error || '', /not a directory/i);
  });

  it('reports missing package.json', () => {
    const emptyDir = path.join(testRoot, 'empty-node-dir');
    fs.mkdirSync(emptyDir, { recursive: true });
    const res = inspectProject(emptyDir);
    assert.equal(res.isNodeProject, false);
    assert.equal(res.missingChecks.length, 4);
    assert.match(res.error || '', /No package\.json/i);
  });

  it('handles malformed package.json syntax without crashing', () => {
    const malformedDir = path.join(testRoot, 'malformed-dir');
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, 'package.json'), '{ "name": "bad", broken }');

    const res = inspectProject(malformedDir);
    assert.equal(res.isNodeProject, true);
    assert.match(res.error || '', /Failed to parse package\.json/i);
  });

  it('handles package.json where root is an array', () => {
    const arrayDir = path.join(testRoot, 'array-dir');
    fs.mkdirSync(arrayDir, { recursive: true });
    fs.writeFileSync(path.join(arrayDir, 'package.json'), '["not", "an", "object"]');

    const res = inspectProject(arrayDir);
    assert.equal(res.isNodeProject, true);
    assert.match(res.error || '', /root must be an object/i);
  });

  it('identifies placeholder npm init test script', () => {
    assert.equal(isPlaceholderTestScript('echo "Error: no test specified" && exit 1'), true);
    assert.equal(isPlaceholderTestScript('echo \'Error: no test specified\' && exit 1'), true);
    assert.equal(isPlaceholderTestScript('jest --coverage'), false);
    assert.equal(isPlaceholderTestScript(undefined), true);
  });

  it('correctly inspects a valid TypeScript Node project', () => {
    const validDir = path.join(testRoot, 'valid-ts-project');
    fs.mkdirSync(validDir, { recursive: true });

    fs.writeFileSync(
      path.join(validDir, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        version: '1.0.0',
        scripts: {
          test: 'node --test',
          build: 'tsc -p ./',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      })
    );
    fs.writeFileSync(path.join(validDir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(validDir, 'package-lock.json'), '{}');

    // Create a mock node_modules directory
    const nmDir = path.join(validDir, 'node_modules', 'sample-dep');
    fs.mkdirSync(nmDir, { recursive: true });

    const res = inspectProject(validDir);

    assert.equal(res.isNodeProject, true);
    assert.equal(res.packageName, 'sample-project');
    assert.equal(res.version, '1.0.0');
    assert.equal(res.hasTsConfig, true);
    assert.equal(res.lockfile, 'npm');
    assert.equal(res.dependenciesInstalled, true);
    assert.equal(res.availableChecks.test, 'node --test');
    assert.equal(res.availableChecks.build, 'tsc -p ./');
    assert.equal(res.availableChecks.lint, 'eslint .');
    assert.equal(res.availableChecks.typecheck, 'tsc --noEmit');
    assert.equal(res.missingChecks.length, 0);
    assert.equal(res.recommendedCheck, 'test');
  });

  it('marks missing checks and flags uninstalled dependencies', () => {
    const partialDir = path.join(testRoot, 'partial-project');
    fs.mkdirSync(partialDir, { recursive: true });

    fs.writeFileSync(
      path.join(partialDir, 'package.json'),
      JSON.stringify({
        name: 'minimal-project',
        scripts: {
          test: 'echo "Error: no test specified" && exit 1', // placeholder
          build: 'vite build',
        },
      })
    );

    const res = inspectProject(partialDir);

    assert.equal(res.isNodeProject, true);
    assert.equal(res.dependenciesInstalled, false); // no node_modules
    assert.equal(res.availableChecks.test, undefined); // placeholder ignored
    assert.equal(res.availableChecks.build, 'vite build');
    assert.ok(res.missingChecks.includes('test'));
    assert.ok(res.missingChecks.includes('lint'));
    assert.ok(res.missingChecks.includes('typecheck'));
    assert.equal(res.recommendedCheck, 'build');
  });
});
