import {
  FirstPrSetupPlan,
  LlmClient,
  LlmError,
  LlmGenerateOptions,
  LlmHealthCheckResult
} from './types';
import { validateSetupPlan } from './planValidator';

export interface OllamaClientOptions {
  baseUrl?: string;
  defaultModel?: string;
  maxPayloadBytes?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB
const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

const SYSTEM_SETUP_PLAN_PROMPT = `You are FirstPR, an autonomous local repository onboarding agent.
Analyze the repository inspection data and return ONLY a valid JSON object matching the FirstPrSetupPlan schema.
Do NOT include markdown formatting, code blocks, or conversational text. Output pure JSON only.

Critical Rules:
1. "cwd" must always be a safe relative directory inside the repository. Use "." for repository root. NEVER use "/" or absolute paths.
2. Each item in "steps" MUST have "executable" (a binary name string, e.g. "pnpm", "npm", "pip") and "args" (array of argument strings, e.g. ["install"]). Do NOT put "checkExecutable" or "type" in steps — those belong in "prerequisites".
3. Only specify "fallbackStepId" if referencing another step in "steps". If no fallback is needed, omit "fallbackStepId" entirely.
4. "executable" must NEVER contain shell operators (&, ;, |, <, >, $).

Schema:
{
  "version": "1.0",
  "repositoryName": string,
  "summary": string,
  "prerequisites": [
    {
      "name": string,
      "type": "runtime" | "packageManager" | "tool" | "environment" | "service",
      "checkExecutable": string,
      "checkArgs": string[],
      "required": boolean,
      "description": string
    }
  ],
  "steps": [
    {
      "id": string,
      "title": string,
      "executable": string,
      "args": string[],
      "cwd": ".",
      "timeoutSeconds": number
    }
  ],
  "verificationSteps": [
    {
      "id": string,
      "title": string,
      "executable": string,
      "args": string[],
      "cwd": ".",
      "timeoutSeconds": number
    }
  ]
}`;

export class OllamaClient implements LlmClient {
  readonly providerName = 'ollama';
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly maxPayloadBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: OllamaClientOptions) {
    this.baseUrl = (options?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options?.defaultModel || DEFAULT_MODEL;
    this.maxPayloadBytes = options?.maxPayloadBytes || DEFAULT_MAX_PAYLOAD_BYTES;
    this.fetchImpl = options?.fetchFn || globalThis.fetch;
  }

  /**
   * Checks if Ollama daemon is running and lists installed models.
   */
  async checkHealth(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LlmHealthCheckResult> {
    const timeoutMs = options?.timeoutMs || 5000;
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    const onUserAbort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) {
        return {
          available: false,
          provider: this.providerName,
          endpoint: this.baseUrl,
          models: [],
          error: 'Health check cancelled.'
        };
      }
      options.signal.addEventListener('abort', onUserAbort, { once: true });
    }

    timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal
      });

      if (!response.ok) {
        return {
          available: false,
          provider: this.providerName,
          endpoint: this.baseUrl,
          models: [],
          error: `Ollama returned HTTP status ${response.status}: ${response.statusText}`
        };
      }

      const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const models = Array.isArray(data.models)
        ? data.models.map(m => m.name || m.model || '').filter(Boolean)
        : [];

      return {
        available: true,
        provider: this.providerName,
        endpoint: this.baseUrl,
        models
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        provider: this.providerName,
        endpoint: this.baseUrl,
        models: [],
        error: message
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (options?.signal) {
        options.signal.removeEventListener('abort', onUserAbort);
      }
    }
  }

  /**
   * Returns list of model tags available in Ollama.
   */
  async listModels(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string[]> {
    const health = await this.checkHealth(options);
    if (!health.available) {
      throw new LlmError(
        `Cannot list models: Ollama daemon unreachable at ${this.baseUrl} (${health.error})`,
        'CONNECTION_REFUSED'
      );
    }
    return health.models;
  }

  /**
   * Generates a validated setup plan using Ollama's /api/generate endpoint.
   */
  async generateSetupPlan(prompt: string, options?: LlmGenerateOptions): Promise<FirstPrSetupPlan> {
    const model = options?.model || this.defaultModel;
    const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
    const systemPrompt = options?.systemPrompt || SYSTEM_SETUP_PLAN_PROMPT;

    const controller = new AbortController();
    let isTimedOut = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const onUserAbort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) {
        throw new LlmError('LLM request was cancelled before start.', 'CANCELLED');
      }
      options.signal.addEventListener('abort', onUserAbort, { once: true });
    }

    timeoutId = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, timeoutMs);

    const requestBody = {
      model,
      prompt,
      system: systemPrompt,
      stream: false,
      format: 'json',
      options: {
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {})
      }
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (err: unknown) {
      if (isTimedOut) {
        throw new LlmError(
          `Ollama request timed out after ${timeoutMs}ms.`,
          'TIMEOUT',
          { cause: err }
        );
      }
      if (options?.signal?.aborted) {
        throw new LlmError('LLM request was cancelled.', 'CANCELLED', { cause: err });
      }

      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw new LlmError(
          `Local Ollama daemon is not running at ${this.baseUrl}. Please start Ollama or verify port.`,
          'CONNECTION_REFUSED',
          { cause: err }
        );
      }
      throw new LlmError(`Failed to connect to Ollama: ${msg}`, 'HTTP_ERROR', { cause: err });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (options?.signal) {
        options.signal.removeEventListener('abort', onUserAbort);
      }
    }

    // Check HTTP status
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      if (response.status === 404 || errorText.toLowerCase().includes('not found')) {
        throw new LlmError(
          `Model '${model}' is not installed in local Ollama. Run 'ollama pull ${model}' or select an installed model.`,
          'MODEL_NOT_FOUND',
          { statusCode: response.status }
        );
      }
      throw new LlmError(
        `Ollama returned HTTP ${response.status}: ${errorText || response.statusText}`,
        'HTTP_ERROR',
        { statusCode: response.status }
      );
    }

    // Read response body safely with size bounds
    const rawText = await response.text();
    if (rawText.length > this.maxPayloadBytes) {
      throw new LlmError(
        `Ollama response exceeded maximum allowable size (${rawText.length} bytes > ${this.maxPayloadBytes} bytes limit).`,
        'PAYLOAD_TOO_LARGE'
      );
    }

    let parsedEnvelope: { response?: string; error?: string };
    try {
      parsedEnvelope = JSON.parse(rawText);
    } catch (err) {
      throw new LlmError(
        `Ollama returned unparseable JSON envelope: ${rawText.slice(0, 200)}`,
        'INVALID_RESPONSE',
        { cause: err }
      );
    }

    if (parsedEnvelope.error) {
      if (parsedEnvelope.error.toLowerCase().includes('not found')) {
        throw new LlmError(
          `Model '${model}' not found in local Ollama: ${parsedEnvelope.error}`,
          'MODEL_NOT_FOUND'
        );
      }
      throw new LlmError(`Ollama inference error: ${parsedEnvelope.error}`, 'HTTP_ERROR');
    }

    const modelOutput = parsedEnvelope.response;
    if (typeof modelOutput !== 'string' || !modelOutput.trim()) {
      throw new LlmError(
        'Ollama returned empty response string in payload.',
        'INVALID_RESPONSE'
      );
    }

    // Strip markdown code fences if present
    const cleanedOutput = cleanJsonOutput(modelOutput);

    let planData: unknown;
    try {
      planData = JSON.parse(cleanedOutput);
    } catch (err) {
      throw new LlmError(
        `LLM output was not valid JSON: ${modelOutput.slice(0, 300)}`,
        'INVALID_RESPONSE',
        { cause: err }
      );
    }

    // Validate the parsed plan structure
    const validation = validateSetupPlan(planData);
    if (!validation.isValid || !validation.plan) {
      throw new LlmError(
        `Generated setup plan failed validation:\n- ${validation.errors.join('\n- ')}`,
        'VALIDATION_FAILED',
        { details: validation.errors }
      );
    }

    return validation.plan;
  }
}

/**
 * Strips potential markdown wrapping from LLM output.
 */
function cleanJsonOutput(raw: string): string {
  let text = raw.trim();
  // Strip ```json ... ``` or ``` ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '');
    text = text.replace(/\s*```$/, '');
  }
  return text.trim();
}
