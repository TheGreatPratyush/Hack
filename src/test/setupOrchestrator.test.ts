import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  evaluatePrerequisites,
  extractVersion,
  isVersionCompatible,
  probeBinary
} from '../setup/prerequisiteDetector';
import { SetupOrchestrator } from '../setup/setupOrchestrator';
import { FirstPrSetupPlan } from '../llm';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `firstpr-orch-test-${prefix}-`));
}

function cleanupTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignored
  }
}

describe('SetupOrchestrator & Prerequisite Detection', () => {
  it('probeBinary, extractVersion, and isVersionCompatible utilities work accurately', () => {
    // Test node probe
    const nodeProbe = probeBinary('node', ['--version']);
    assert.equal(nodeProbe.isFound, true);
    assert.ok(nodeProbe.rawOutput.startsWith('v'));
    const nodeVer = extractVersion(nodeProbe.rawOutput);
    assert.ok(nodeVer !== undefined);
    assert.equal(isVersionCompatible(nodeVer!, '>=18.0.0'), true);
    assert.equal(isVersionCompatible(nodeVer!, '>=30.0.0'), false);

    // Test ruby version string extraction
    const rubyVer = extractVersion('ruby 2.6.10p210 (2022-04-12 revision 67958) [universal.arm64e-darwin24]');
    assert.equal(rubyVer, '2.6.10p210');
    assert.equal(isVersionCompatible('2.6.10', '4.0.2'), false);
    assert.equal(isVersionCompatible('4.0.2', '4.0.2'), true);

    // Test nonexistent binary
    const missingProbe = probeBinary('definitely_nonexistent_binary_12345');
    assert.equal(missingProbe.isFound, false);
  });

  it('Requirement 7 Acceptance Test: Reproducible 10-step fixture setup sequence with failure recovery', async () => {
    const tmpDir = createTempDir('acceptance-fixture');
    try {
      // 1. Fixture declares package.json with standard scripts
      const packageJson = {
        name: 'test-fixture-project',
        version: '1.0.0',
        scripts: {
          test: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(0)"'
        }
      };
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(packageJson, null, 2));

      // Create a mock install script that succeeds
      const installScript = path.join(tmpDir, 'mock_install.js');
      fs.writeFileSync(installScript, 'console.log("Mock dependencies installed successfully"); process.exit(0);');

      // Create a mock failing script that fails on first run
      const failScript = path.join(tmpDir, 'mock_fail.js');
      fs.writeFileSync(failScript, 'console.error("Deliberate failure for recovery test"); process.exit(1);');

      // Create a recovery script that succeeds
      const recoveryScript = path.join(tmpDir, 'mock_recovery.js');
      fs.writeFileSync(recoveryScript, 'console.log("Recovery action executed successfully"); process.exit(0);');

      // Mock setup plan with 3 steps
      const mockPlan: FirstPrSetupPlan = {
        version: '1.0',
        repositoryName: 'test-fixture-project',
        summary: 'Controlled fixture setup test',
        prerequisites: [
          { name: 'node', type: 'runtime', checkExecutable: 'node', checkArgs: ['--version'], required: true }
        ],
        steps: [
          {
            id: 'step-install',
            title: 'Install fixture dependencies',
            executable: 'node',
            args: ['mock_install.js'],
            cwd: '.'
          },
          {
            id: 'step-failing',
            title: 'Deliberate failing step',
            executable: 'node',
            args: ['mock_fail.js'],
            cwd: '.',
            fallbackStepId: 'step-recovery'
          },
          {
            id: 'step-recovery',
            title: 'Recovery fallback step',
            executable: 'node',
            args: ['mock_recovery.js'],
            cwd: '.'
          }
        ],
        verificationSteps: [
          {
            id: 'step-verify',
            title: 'Verify setup check',
            executable: 'node',
            args: ['mock_install.js'],
            cwd: '.'
          }
        ]
      };

      const mockLlmClient = {
        providerName: 'mock',
        checkHealth: async () => ({ available: true, provider: 'mock', endpoint: 'mock', models: ['mock'] }),
        listModels: async () => ['mock'],
        generateSetupPlan: async () => mockPlan
      };

      const orchestrator = new SetupOrchestrator(tmpDir, {
        llmClient: mockLlmClient
      });

      // 2. Initialize orchestrator -> Detects prerequisites and transitions to awaiting_approval
      const snapInit = await orchestrator.initialize();
      assert.equal(snapInit.state, 'awaiting_approval');
      assert.ok(snapInit.prerequisites.length > 0);
      assert.equal(snapInit.prerequisites[0].status, 'satisfied');
      assert.equal(orchestrator.steps.length, 4); // 3 steps + 1 verification step

      // 3. Step 1: Reject unapproved execution -> Does not spawn process
      const rejectedStep = orchestrator.rejectCurrentStep();
      assert.equal(rejectedStep.status, 'rejected');
      assert.equal(rejectedStep.exitCode, null);
      assert.equal(orchestrator.state, 'blocked');

      // 4. Retry and approve Step 1
      orchestrator.retryCurrentStep();
      assert.equal(orchestrator.state, 'awaiting_approval');

      const step1Result = await orchestrator.approveAndExecuteCurrentStep();
      assert.equal(step1Result.status, 'completed');
      assert.equal(step1Result.exitCode, 0);
      assert.ok(step1Result.stdout?.includes('Mock dependencies installed successfully'));

      // 5. Orchestrator advanced to Step 2 (failing step)
      assert.equal(orchestrator.currentStep?.id, 'step-failing');
      assert.equal(orchestrator.state, 'awaiting_approval');

      // 6. Execute failing step -> Captures non-zero exit code and transitions to recovering_from_failure
      const step2Result = await orchestrator.approveAndExecuteCurrentStep();
      assert.equal(step2Result.status, 'failed');
      assert.equal(step2Result.exitCode, 1);
      assert.ok(step2Result.stderr?.includes('Deliberate failure for recovery test'));
      assert.equal(orchestrator.state, 'recovering_from_failure');

      // 7. Verify suggested recovery step was generated
      assert.ok(step2Result.suggestedRecovery !== undefined);
      assert.equal(step2Result.suggestedRecovery?.executable, 'node');
      assert.deepEqual(step2Result.suggestedRecovery?.args, ['mock_recovery.js']);

      // 8. Apply recovery step
      orchestrator.applyRecoveryStep();
      assert.equal(orchestrator.state, 'awaiting_approval');
      assert.equal(orchestrator.currentStep?.title, 'Recovery fallback step');

      // 9. Execute recovery step -> Succeeded
      const recoveryResult = await orchestrator.approveAndExecuteCurrentStep();
      assert.equal(recoveryResult.status, 'completed');
      assert.equal(recoveryResult.exitCode, 0);

      // 10. Execute remaining steps (step-recovery original and verification step)
      while (orchestrator.currentStep && orchestrator.state === 'awaiting_approval') {
        await orchestrator.approveAndExecuteCurrentStep();
      }

      // Final readiness state reached
      assert.equal(orchestrator.state, 'ready');
      assert.ok(orchestrator.readinessReport !== null);
      assert.equal(orchestrator.readinessReport?.verdict, 'ready');
      assert.ok(orchestrator.readinessReport?.completedSteps.length >= 3);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('evaluates prerequisites and limitations on CircuitVerse repository', async () => {
    const circuitVersePath = '/Users/pratyushgupta/Desktop/demo/demo2';
    if (!fs.existsSync(circuitVersePath)) {
      return;
    }

    const { extractRepoContext } = await import('../setup/contextExtractor');
    const evidence = await extractRepoContext(circuitVersePath);
    const prereqs = await evaluatePrerequisites(circuitVersePath, evidence);

    // Verify Node prerequisite
    const nodePrereq = prereqs.find(p => p.name === 'node');
    assert.ok(nodePrereq);
    assert.equal(nodePrereq.status, 'satisfied');

    // Verify Yarn prerequisite
    const yarnPrereq = prereqs.find(p => p.name === 'yarn');
    assert.ok(yarnPrereq);
    assert.equal(yarnPrereq.status, 'satisfied');

    // Verify Ruby prerequisite: Host has Ruby 2.6.10, but CircuitVerse requires 4.0.2 -> incompatible
    const rubyPrereq = prereqs.find(p => p.name === 'ruby');
    assert.ok(rubyPrereq);
    assert.equal(rubyPrereq.status, 'incompatible');
    assert.equal(rubyPrereq.requiredVersion, '4.0.2');
    assert.ok(rubyPrereq.remediationRecommendation?.includes('rbenv'));

    // Verify Database config prerequisite
    const dbConfigPrereq = prereqs.find(p => p.name === 'database_config');
    assert.ok(dbConfigPrereq);
    assert.ok(dbConfigPrereq.remediationRecommendation?.includes('database.example.yml'));

    // Verify Docker prerequisite
    const dockerPrereq = prereqs.find(p => p.name === 'docker');
    assert.ok(dockerPrereq);
    assert.equal(dockerPrereq.status, 'satisfied'); // Docker is installed on host
  });
});
