import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  validateSetupPlan,
  OllamaClient,
  LlmError,
  FirstPrSetupPlan
} from '../llm';

describe('planValidator — Setup Plan Validation & Security', () => {
  it('accepts a valid minimal setup plan', () => {
    const raw = {
      version: '1.0',
      summary: 'Standard Node project setup using npm.',
      steps: [
        {
          id: 'install-deps',
          title: 'Install dependencies',
          executable: 'npm',
          args: ['ci']
        }
      ]
    };

    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.plan);
    assert.strictEqual(result.plan.version, '1.0');
    assert.strictEqual(result.plan.steps.length, 1);
    assert.strictEqual(result.plan.steps[0].id, 'install-deps');
    assert.strictEqual(result.plan.steps[0].executable, 'npm');
    assert.deepStrictEqual(result.plan.steps[0].args, ['ci']);
  });

  it('accepts a comprehensive valid setup plan with prerequisites, cwd, env, and verification steps', () => {
    const raw: FirstPrSetupPlan = {
      version: '1.0',
      repositoryName: 'kolibri',
      summary: 'Kolibri monorepo setup requiring pnpm and Python 3.10.',
      prerequisites: [
        {
          name: 'pnpm',
          type: 'packageManager',
          checkExecutable: 'pnpm',
          checkArgs: ['--version'],
          required: true,
          description: 'Package manager pnpm 10.x'
        },
        {
          name: 'python',
          type: 'runtime',
          checkExecutable: 'python3',
          checkArgs: ['--version'],
          required: true
        }
      ],
      steps: [
        {
          id: 'step-1-pnpm-install',
          title: 'Install JavaScript dependencies with frozen lockfile',
          executable: 'pnpm',
          args: ['install', '--frozen-lockfile'],
          cwd: '.',
          timeoutSeconds: 300,
          allowFailure: false,
          fallbackStepId: 'step-1-fallback'
        },
        {
          id: 'step-1-fallback',
          title: 'Install JavaScript dependencies without frozen lockfile',
          executable: 'pnpm',
          args: ['install', '--no-frozen-lockfile'],
          cwd: '.',
          timeoutSeconds: 300
        }
      ],
      verificationSteps: [
        {
          id: 'step-verify-build',
          title: 'Verify build',
          executable: 'pnpm',
          args: ['run', 'build'],
          cwd: '.',
          timeoutSeconds: 180
        }
      ]
    };

    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.plan);
    assert.strictEqual(result.plan.repositoryName, 'kolibri');
    assert.strictEqual(result.plan.prerequisites?.length, 2);
    assert.strictEqual(result.plan.steps.length, 2);
    assert.strictEqual(result.plan.verificationSteps?.length, 1);
  });

  it('rejects non-object or null data', () => {
    assert.strictEqual(validateSetupPlan(null).isValid, false);
    assert.strictEqual(validateSetupPlan(undefined).isValid, false);
    assert.strictEqual(validateSetupPlan('string').isValid, false);
    assert.strictEqual(validateSetupPlan([1, 2, 3]).isValid, false);
  });

  it('rejects missing version or summary', () => {
    const noVersion = { summary: 'A plan', steps: [{ id: 's1', title: 't', executable: 'npm', args: [] }] };
    assert.strictEqual(validateSetupPlan(noVersion).isValid, false);

    const noSummary = { version: '1.0', steps: [{ id: 's1', title: 't', executable: 'npm', args: [] }] };
    assert.strictEqual(validateSetupPlan(noSummary).isValid, false);
  });

  it('rejects non-array or empty steps', () => {
    const noSteps = { version: '1.0', summary: 'test' };
    assert.strictEqual(validateSetupPlan(noSteps).isValid, false);

    const emptySteps = { version: '1.0', summary: 'test', steps: [] };
    assert.strictEqual(validateSetupPlan(emptySteps).isValid, false);
  });

  it('rejects duplicate step IDs', () => {
    const raw = {
      version: '1.0',
      summary: 'Duplicate IDs',
      steps: [
        { id: 'step-1', title: 'Step 1', executable: 'npm', args: ['install'] },
        { id: 'step-1', title: 'Step 1 duplicate', executable: 'npm', args: ['test'] }
      ]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes("Duplicate step ID 'step-1'")));
  });

  it('rejects shell metacharacters in executable', () => {
    const injectionAttempts = [
      'npm install && rm -rf /',
      'pnpm; echo pwned',
      'node | sh',
      'echo `whoami`',
      'cat < /etc/passwd',
      'npm > out.txt',
      'eval $COMMAND'
    ];

    for (const badExec of injectionAttempts) {
      const raw = {
        version: '1.0',
        summary: 'Injection test',
        steps: [{ id: 'step-bad', title: 'Bad', executable: badExec, args: ['install'] }]
      };
      const result = validateSetupPlan(raw);
      assert.strictEqual(result.isValid, false, `Expected '${badExec}' to be rejected`);
      assert.ok(result.errors.some(e => e.includes('forbidden shell metacharacters')));
    }
  });

  it('rejects args when passed as a raw string instead of string array', () => {
    const raw = {
      version: '1.0',
      summary: 'Invalid args shape',
      steps: [{ id: 'step-1', title: 'Install', executable: 'npm', args: 'install --frozen-lockfile' }]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes("'args' must be an array of strings")));
  });

  it('rejects directory traversal and absolute paths in cwd', () => {
    const badCwds = [
      '../secret',
      '../../',
      'packages/../../etc',
      '/usr/local/bin',
      '/etc',
      '~/.ssh'
    ];

    for (const badCwd of badCwds) {
      const raw = {
        version: '1.0',
        summary: 'Bad cwd test',
        steps: [{ id: 'step-cwd', title: 'Step', executable: 'npm', args: ['test'], cwd: badCwd }]
      };
      const result = validateSetupPlan(raw);
      assert.strictEqual(result.isValid, false, `Expected cwd '${badCwd}' to be rejected`);
      assert.ok(result.errors.some(e => e.includes('must be a relative path and cannot traverse')));
    }
  });

  it('accepts safe relative cwd subdirectories', () => {
    const safeCwds = ['.', 'frontend', 'packages/core', 'apps/web'];
    for (const safeCwd of safeCwds) {
      const raw = {
        version: '1.0',
        summary: 'Safe cwd',
        steps: [{ id: 'step-cwd', title: 'Step', executable: 'npm', args: ['test'], cwd: safeCwd }]
      };
      const result = validateSetupPlan(raw);
      assert.strictEqual(result.isValid, true, `Expected safe cwd '${safeCwd}' to pass`);
    }
  });

  it('rejects self-referencing fallbackStepId', () => {
    const raw = {
      version: '1.0',
      summary: 'Self fallback',
      steps: [
        { id: 'step-1', title: 'Step 1', executable: 'npm', args: ['ci'], fallbackStepId: 'step-1' }
      ]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes('fallbackStepId cannot reference itself')));
  });

  it('rejects nonexistent fallbackStepId', () => {
    const raw = {
      version: '1.0',
      summary: 'Nonexistent fallback',
      steps: [
        { id: 'step-1', title: 'Step 1', executable: 'npm', args: ['ci'], fallbackStepId: 'ghost-step' }
      ]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes("references nonexistent fallbackStepId 'ghost-step'")));
  });

  it('rejects cyclic fallbackStepId references (A -> B -> A)', () => {
    const raw = {
      version: '1.0',
      summary: 'Cycle test',
      steps: [
        { id: 'step-a', title: 'Step A', executable: 'npm', args: ['install'], fallbackStepId: 'step-b' },
        { id: 'step-b', title: 'Step B', executable: 'npm', args: ['install'], fallbackStepId: 'step-a' }
      ]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes('Cyclic fallback detected')));
  });

  it('rejects 3-step cyclic fallback chain (A -> B -> C -> A)', () => {
    const raw = {
      version: '1.0',
      summary: '3-way cycle',
      steps: [
        { id: 'step-a', title: 'Step A', executable: 'npm', args: ['1'], fallbackStepId: 'step-b' },
        { id: 'step-b', title: 'Step B', executable: 'npm', args: ['2'], fallbackStepId: 'step-c' },
        { id: 'step-c', title: 'Step C', executable: 'npm', args: ['3'], fallbackStepId: 'step-a' }
      ]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes('Cyclic fallback detected')));
  });

  it('rejects invalid timeoutSeconds values', () => {
    const invalidTimeouts = [-1, 0, NaN, Infinity, 999999];
    for (const badTimeout of invalidTimeouts) {
      const raw = {
        version: '1.0',
        summary: 'Timeout test',
        steps: [{ id: 'step-1', title: 'Step', executable: 'npm', args: [], timeoutSeconds: badTimeout }]
      };
      const result = validateSetupPlan(raw);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.errors.some(e => e.includes('timeoutSeconds must be a positive number up to 3600')));
    }
  });

  it('rejects invalid prerequisite type or metacharacters in checkExecutable', () => {
    const raw = {
      version: '1.0',
      summary: 'Prereq test',
      prerequisites: [
        { name: 'redis', type: 'unknownType' as any, required: true },
        { name: 'db', type: 'service' as const, checkExecutable: 'db; rm -rf', required: true }
      ],
      steps: [{ id: 'step-1', title: 'Step', executable: 'npm', args: [] }]
    };
    const result = validateSetupPlan(raw);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.errors.some(e => e.includes("invalid type 'unknownType'")));
    assert.ok(result.errors.some(e => e.includes('forbidden shell metacharacters')));
  });
});

describe('OllamaClient — Local LLM Client Adapter', () => {
  it('reports healthy when Ollama daemon is reachable and lists models', async () => {
    const mockFetch: typeof fetch = async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({
          models: [
            { name: 'qwen3:8b', size: 5225388164 },
            { name: 'qwen2.5-coder:7b', size: 4700000000 }
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    const health = await client.checkHealth();

    assert.strictEqual(health.available, true);
    assert.strictEqual(health.provider, 'ollama');
    assert.strictEqual(health.endpoint, 'http://127.0.0.1:11434');
    assert.deepStrictEqual(health.models, ['qwen3:8b', 'qwen2.5-coder:7b']);

    const models = await client.listModels();
    assert.deepStrictEqual(models, ['qwen3:8b', 'qwen2.5-coder:7b']);
  });

  it('reports unhealthy when Ollama connection is refused without throwing uncaught error', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    const health = await client.checkHealth();

    assert.strictEqual(health.available, false);
    assert.ok(health.error?.includes('ECONNREFUSED'));

    await assert.rejects(
      async () => client.listModels(),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'CONNECTION_REFUSED');
        return true;
      }
    );
  });

  it('successfully generates and parses a validated setup plan', async () => {
    const planPayload = {
      version: '1.0',
      repositoryName: 'kolibri',
      summary: 'Automated Kolibri setup using pnpm.',
      steps: [
        {
          id: 'pnpm-install',
          title: 'Install dependencies',
          executable: 'pnpm',
          args: ['install'],
          cwd: '.'
        }
      ]
    };

    const mockFetch: typeof fetch = async (url, init) => {
      assert.strictEqual(String(url), 'http://127.0.0.1:11434/api/generate');
      const body = JSON.parse(String(init?.body));
      assert.strictEqual(body.model, 'qwen2.5-coder:7b');
      assert.strictEqual(body.format, 'json');

      return new Response(JSON.stringify({
        model: 'qwen2.5-coder:7b',
        response: JSON.stringify(planPayload),
        done: true
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    const plan = await client.generateSetupPlan('Plan setup for Kolibri');

    assert.strictEqual(plan.version, '1.0');
    assert.strictEqual(plan.repositoryName, 'kolibri');
    assert.strictEqual(plan.steps.length, 1);
    assert.strictEqual(plan.steps[0].id, 'pnpm-install');
    assert.strictEqual(plan.steps[0].executable, 'pnpm');
    assert.deepStrictEqual(plan.steps[0].args, ['install']);
  });

  it('strips markdown code blocks around JSON in model response', async () => {
    const planPayload = {
      version: '1.0',
      summary: 'Setup wrapped in markdown fences.',
      steps: [{ id: 's1', title: 'Step 1', executable: 'npm', args: ['ci'] }]
    };

    const markdownResponse = `\`\`\`json\n${JSON.stringify(planPayload, null, 2)}\n\`\`\``;

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({
        model: 'qwen3:8b',
        response: markdownResponse,
        done: true
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const client = new OllamaClient({ defaultModel: 'qwen3:8b', fetchFn: mockFetch });
    const plan = await client.generateSetupPlan('Test prompt');

    assert.strictEqual(plan.version, '1.0');
    assert.strictEqual(plan.steps[0].id, 's1');
  });

  it('throws INVALID_RESPONSE when model output is not valid JSON', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({
        model: 'qwen3:8b',
        response: 'Sorry, I am unable to format this as JSON for you right now.',
        done: true
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt'),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'INVALID_RESPONSE');
        assert.ok(err.message.includes('not valid JSON'));
        return true;
      }
    );
  });

  it('throws VALIDATION_FAILED when model output violates setup plan schema', async () => {
    const invalidPlan = {
      version: '1.0',
      summary: 'Invalid plan with shell injection in executable',
      steps: [
        {
          id: 'step-1',
          title: 'Dangerous step',
          executable: 'npm run test && rm -rf /',
          args: []
        }
      ]
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({
        model: 'qwen3:8b',
        response: JSON.stringify(invalidPlan),
        done: true
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt'),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'VALIDATION_FAILED');
        assert.ok(err.details && err.details.length > 0);
        assert.ok(err.message.includes('forbidden shell metacharacters'));
        return true;
      }
    );
  });

  it('throws MODEL_NOT_FOUND when Ollama returns 404', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({
        error: 'model "qwen2.5-coder:7b" not found, try pulling it first'
      }), { status: 404, statusText: 'Not Found' });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt'),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'MODEL_NOT_FOUND');
        assert.strictEqual(err.statusCode, 404);
        assert.ok(err.message.includes('is not installed'));
        return true;
      }
    );
  });

  it('throws HTTP_ERROR when Ollama returns 500 server error', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('CUDA out of memory', { status: 500, statusText: 'Internal Server Error' });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt'),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'HTTP_ERROR');
        assert.strictEqual(err.statusCode, 500);
        return true;
      }
    );
  });

  it('throws CANCELLED when request is aborted by caller signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new OllamaClient();
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt', { signal: controller.signal }),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'CANCELLED');
        return true;
      }
    );
  });

  it('throws TIMEOUT when request exceeds configured timeoutMs', async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }
      });
    };

    const client = new OllamaClient({ fetchFn: mockFetch });
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt', { timeoutMs: 25 }),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'TIMEOUT');
        assert.ok(err.message.includes('timed out after 25ms'));
        return true;
      }
    );
  });

  it('throws PAYLOAD_TOO_LARGE when response body exceeds maxPayloadBytes limit', async () => {
    const hugeResponse = JSON.stringify({
      model: 'qwen3:8b',
      response: 'x'.repeat(1000),
      done: true
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(hugeResponse, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const client = new OllamaClient({ maxPayloadBytes: 200, fetchFn: mockFetch });
    await assert.rejects(
      async () => client.generateSetupPlan('Test prompt'),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.strictEqual(err.code, 'PAYLOAD_TOO_LARGE');
        return true;
      }
    );
  });
});
