# FirstPR — Project Status & Architecture Record

## Workspace & Environment State
- **Workspace Path:** `/Users/pratyushgupta/Desktop/Winner`
- **Initial Status:** Clean directory (no existing code or scaffolding).
- **Verified Tooling:**
  - **Node.js:** `v22.23.1`
  - **npm:** `10.9.8`
  - **Git:** `2.39.5 (Apple Git-154)`
  - **VS Code CLI:** `1.143.1` (`/usr/local/bin/code`)

## Core Architecture Decision
- **Platform:** Native VS Code Extension (TypeScript).
- **Execution Model:** 100% Local-first. No external backend, no database, no telemetry, no paid AI APIs.
- **UI:** VS Code Activity Bar / Primary Sidebar Webview (`WebviewViewProvider`) containing a clean, single-input URL form, live stage progress indicators, approval prompts, and an evidence-backed diagnostic report viewer.
- **Process & Security Model:**
  - Safe local staging directory: `~/FirstPR/repositories/<owner>-<repo>`.
  - Explicit user approval required before running `npm install` (with notice about lifecycle scripts) or executing checks.
  - Safe process execution via `child_process.spawn` using strict argument arrays with `shell: false` (no shell interpolation).
  - Script validation: checks script names against injection patterns (`^[a-zA-Z0-9_.:-]+$`) and validates against inspected `package.json` scripts.
  - Execution bounded by timeouts (60s checks, 180s installs) and output buffer limits (100KB per stream).
- **Diagnostics & Fix Engine:**
  - Deterministic rule-based analysis parsing real stdout/stderr and `package.json` configurations.
  - Strict separation of facts (Observed Evidence) from hypotheses (Likely Explanations).
  - Zero disk modifications prior to explicit human review of a unified diff.
  - SHA-256 content hashing to prevent applying patches to stale or conflicting files.
  - Automated re-check execution to verify whether a patch resolves the original failure.
  - One-click safe rollback protecting subsequent independent user edits.

---

## Phase / Milestone Execution History

### Milestone 0: Workspace Inspection and Architecture Lock
- **Status:** `COMPLETE`
- **Verified:** Tooling, workspace state, locked phased plan, remote configured.

### Milestone 1: Extension Skeleton & Remote Foundation Checkpoint
- **Status:** `COMPLETE`
- **Commit:** `017c3defce53d0d625ab72e48cf5f248dfca12f3` pushed to `origin/main`.
- **Deliverables:** Extension scaffold, manifest, TypeScript setup, sidebar Webview with URL validation, safe workspace manager, Git clone engine, and 24 unit tests.

### Milestone 2: Repository Inspection and Check Runner
- **Status:** `COMPLETE`
- **Commit:** `0fb99f880a59a90270ecff80d81136c60b9f33b3` pushed to `origin/main`.
- **Deliverables:** Project Inspector, Check Runner with argument arrays & timeouts, permission-gated execution UI, 40 unit tests across 5 suites.

### Milestone 3: Evidence-to-Issue Diagnostic Engine
- **Status:** `COMPLETE`
- **Commit:** `6308f7c2fe8a40cd0634963c1b5fb5d3be72c001` pushed to `origin/main`.
- **Deliverables:** Diagnostic Engine (TypeScript compile errors, test assertion failures, missing modules, syntax errors), structured issue cards in UI, offline demo fixture (`fixtures/demo-calc/`), 52 unit/integration tests across 7 suites.

### Milestone 4: Safe Fix Proposal, Diff Preview, and Re-verification
- **Status:** `COMPLETE`
- **Deliverables:**
  - **Fix Engine (`src/fixes/fixEngine.ts`):**
    - Deterministic fix generation for supported cases (return value type/format discrepancy, missing dependency declaration, TypeScript type literal fixes).
    - Refuses to propose speculative patches for ambiguous or unconfirmed errors.
    - Unified diff generator (`generateUnifiedDiff`) with standard headers and context lines.
    - Path traversal protection ensuring all edits are strictly within workspace bounds.
    - Content hashing (SHA-256) detecting disk modifications and rejecting stale diff previews.
    - Atomic file patch application producing a `FixRollbackRecord`.
    - Safe rollback engine (`rollbackAppliedFix`) verifying file integrity before restoring original content.
  - **Sidebar UI Integration (`src/ui/SidebarProvider.ts`):**
    - Diff Preview Card: displays proposed fix title, description, target file, syntax-highlighted unified diff box (green `+` added, red `-` deleted), and safety notes.
    - Approval Action: "Approve & Apply Fix (Re-verifies Check)" requires explicit user click.
    - Re-verification Pipeline: automatically re-executes the failed check after patch application.
    - Outcome Status: renders bright green "Fix Verified Successfully" card upon exit code 0, or clear failure notice if re-check fails.
    - Rollback Control: "Rollback Patch" button restores original source file with confirmation.
  - **Automated Tests:**
    - `src/test/fixEngine.test.ts` (8 unit tests covering diff generation, deterministic proposal, conflict detection, rollback, traversal rejection).
    - `src/test/endToEndFixPipeline.test.ts` (integration test covering failure capture $\to$ diff preview $\to$ user approval $\to$ verified exit code 0 $\to$ rollback).
    - Total test suite: 61 tests across 9 suites (100% passing).
- **Files Created/Modified:**
  - `src/fixes/fixEngine.ts` (created)
  - `src/test/fixEngine.test.ts` (created)
  - `src/test/endToEndFixPipeline.test.ts` (created)
  - `src/ui/SidebarProvider.ts` (updated)
  - `PROJECT_STATUS.md` (updated)
- **Commit:** `050eb6df977a59b5c7fe87b86512d94462737aca` pushed to `origin/main`.

### Milestone 5: Safe Git Branch & Pull Request Preparation
- **Status:** `COMPLETE`
- **Deliverables:**
  - **Git PR Service (`src/git/prService.ts`):**
    - Target repository preflight inspector (`preflightTargetRepo`): checks worktree validity, detects detached HEAD, detects pre-existing unrelated changes, prevents accidental sweeps.
    - Safe branch name generator & validator (`sanitizeBranchSlug`, `isValidBranchName`, `buildBranchName`): enforces safe git-ref patterns (`firstpr/fix-<slug>`).
    - Dedicated branch switcher (`createAndCheckoutBranch`): creates and checks out feature branch safely without losing uncommitted user changes.
    - Isolated commit engine (`commitVerifiedFix`): stages strictly the approved fix files (`git add -- <file>`), verifies `git diff --cached` contains no unapproved files, prevents path traversal, captures git author errors gracefully.
    - Pull Request generator (`generatePullRequestDetails`): builds standard PR title and structured markdown body citing evidence and local verification status; constructs direct GitHub Compare URL (`/compare/base...feature?expand=1&title=...&body=...`).
    - GitHub CLI integration (`checkGhCli`, `createPullRequestWithGh`): checks `gh` CLI installation and auth state, supports optional direct PR creation from within VS Code.
  - **Sidebar UI Integration (`src/ui/SidebarProvider.ts`):**
    - "Prepare Pull Request" workflow triggered after successful check re-verification.
    - Branch Preparation UI: proposed branch name with preflight repository health indicator.
    - Commit Review UI: displays staged file, editable commit title, and structured verification commit message body.
    - PR Submission Card: primary one-click "Open Pull Request on GitHub" button opening browser Compare link, plus optional "Create PR via GitHub CLI" button.
  - **Automated Tests:**
    - `src/test/prService.test.ts` (14 unit tests covering slug sanitization, ref validation, repo parsing, compare URL generation, preflight checks, dirty repo protection, branch creation, isolated commit, traversal prevention, gh CLI detection).
    - `src/test/endToEndPrPipeline.test.ts` (full integration test covering inspection $\to$ failure capture $\to$ diagnosis $\to$ fix $\to$ re-verification $\to$ branch creation $\to$ isolated staging $\to$ commit $\to$ PR compare URL).
    - Total test suite: 76 tests across 15 suites (100% passing).
- **Files Created/Modified:**
  - `src/git/prService.ts` (created)
  - `src/test/prService.test.ts` (created)
  - `src/test/endToEndPrPipeline.test.ts` (created)
  - `src/ui/SidebarProvider.ts` (updated)
  - `PROJECT_STATUS.md` (updated)
- **Commands Executed & Results:**
  - `npm run compile`: Compiled TypeScript cleanly (`tsc -p ./`) with code 0.
  - `npm test`: Ran 76 unit/integration tests across 15 suites. Result: 76 passed, 0 failed in 1.33s.
  - `npx @vscode/vsce ls`: Verified packaging manifest integrity. Exited with code 0.

---

## Strategic Roadmap Evolution: Local-LLM Repository Agent

Following intermediate hackathon evaluation, FirstPR is adopting a **Local LLM-assisted architecture** for repository analysis, environment setup planning, failure recovery, and diagnostic reasoning, while preserving deterministic execution guardrails and human-in-the-loop approvals.

### Updated Milestone Plan

- **Milestone 6: Architecture and Local Model Selection**
  - **Status:** `COMPLETE`
  - Host Hardware Verified: Apple MacBook Pro M4 (10 cores), 16 GB unified RAM, 209 GB free SSD space, macOS 26.6.1.
  - Local Tooling Audited: Ollama 0.33.2 detected at `/usr/local/bin/ollama`, daemon running on `http://127.0.0.1:11434`.
  - Cached Model Detected: `qwen3:8b` (5.2 GB, Q4_K_M).
  - Target Default Candidate Model: `qwen2.5-coder:7b` selected for code generation and schema adherence.
  - Strategic 12-milestone roadmap established.

- **Milestone 7: Local LLM Client Integration**
  - **Status:** `COMPLETE`
  - **Deliverables:**
    - **Provider-Independent Types (`src/llm/types.ts`):** Defined `SetupPrerequisite`, `SetupStep`, `FirstPrSetupPlan`, `PlanValidationResult`, `LlmClient`, `LlmGenerateOptions`, `LlmHealthCheckResult`, and typed `LlmError` with error codes (`CONNECTION_REFUSED`, `MODEL_NOT_FOUND`, `TIMEOUT`, `CANCELLED`, `INVALID_RESPONSE`, `VALIDATION_FAILED`, `HTTP_ERROR`, `PAYLOAD_TOO_LARGE`).
    - **Strict Runtime Schema Validator (`src/llm/planValidator.ts`):** Pure TypeScript schema enforcement validating required fields, unique step IDs, executable + args array separation (forbids raw shell strings and shell metacharacters `;&|<>$`), path traversal prevention in `cwd` (forbids absolute paths, `..`, and home directory expansion), timeout bounds (1–3600s), acyclic fallback graph traversal (detects self-referencing and multi-step circular fallback loops).
    - **Local Ollama Adapter (`src/llm/ollamaClient.ts`):** Connects to local Ollama runtime via HTTP API (`http://127.0.0.1:11434`). Supports health checks (`/api/tags`), model listing, bounded response size enforcement (512 KB), native `fetch` with `AbortSignal` and timeout propagation, markdown code fence stripping, and schema validation. Zero external cloud dependencies, zero telemetry, zero secrets exfiltration.
    - **Automated Tests:**
      - `src/test/llmClient.test.ts`: 27 unit tests covering schema validation, shell metacharacter rejection, directory traversal prevention, cyclic fallback detection, mocked HTTP responses (health check, connection refused, valid plan, markdown stripping, invalid JSON, schema failure, 404 model not found, 500 error, timeout, user cancellation, payload size limits).
      - Total test suite: 103 tests across 17 suites (100% passing).
    - **Live On-Device Model Suitability Smoke Test:**
      - Evaluated on-device cached `qwen3:8b` against local Ollama running on Apple M4.
      - Generated response in ~22.5s.
      - Demonstrated critical value of `validateSetupPlan`: caught attempts by the general conversational model to emit `/` for cwd and conflate prerequisite check fields with executable step fields, proving the necessity of `validateSetupPlan` guardrails and confirming `qwen2.5-coder:7b` as the superior coder model candidate.
      - Preserved safety constraint: zero model-generated commands executed on disk.
  - **Files Created/Modified:**
    - `src/llm/types.ts` (created)
    - `src/llm/planValidator.ts` (created)
    - `src/llm/ollamaClient.ts` (created)
    - `src/llm/index.ts` (created)
    - `src/test/llmClient.test.ts` (created)
    - `PROJECT_STATUS.md` (updated)
  - **Verification:**
    - `npm run compile`: Compiled TypeScript cleanly with code 0.
    - `npm test`: 103/103 tests passing in 1.39s across 17 suites.
    - `npx @vscode/vsce ls`: Packaging manifest verified cleanly.

- **Milestone 8: Repository Context Extraction & `setup.md` Generation**
  - **Status:** `COMPLETE`
  - **Deliverables:**
    - **Context Extractor (`src/setup/contextExtractor.ts`):**
      - Bounded evidence gathering across README, CONTRIBUTING, CLAUDE/AGENTS instructions, package manifests (`package.json`, `pnpm-workspace.yaml`, `requirements.txt`, `pyproject.toml`, `Makefile`, etc.), and lockfiles.
      - Enforces strict size caps: 200 KB max read limit, 15 KB per-file truncate limit, 60 KB total context cap.
      - Security sanitization: excludes sensitive files (`.env*`, `*token*`, `*secret*`, `*credential*`, `*.pem`, `*.key`, `id_rsa`) and binary media assets.
      - Prompt injection defense: wraps untrusted repository contents in `<untrusted_repo_file>` tags with explicit anti-injection instructions.
      - Deterministic heuristics: detects runtimes (`Node.js`, `Python`) with version hints and package managers (`pnpm`, `npm`, `yarn`, `bun`, `pip`, `poetry`) citing specific evidence sources, detecting lockfile conflicts.
    - **Setup Generator & Runbook Formatter (`src/setup/setupGenerator.ts`):**
      - Builds compact prompt with extracted evidence, detected facts, and anti-injection instructions.
      - Integrates with Milestone 7 `LlmClient` and `validateSetupPlan`.
      - Deterministic failover: `synthesizeFactualBaselinePlan` generates safe factual setup plan if model is unreachable.
      - Formats human-readable `setup.md` clearly separating verified facts from model recommendations, host prerequisites, ordered setup commands, verification checks, and safety review gate.
      - Zero command execution during Milestone 8.
    - **Automated Tests:**
      - `src/test/setupGenerator.test.ts`: 6 comprehensive scenarios covering pnpm monorepo with Node and Python (Kolibri model), standard npm project, missing and conflicting manifests, prompt injection defense, sensitive/oversized file exclusion, and model failure handling.
      - Total test suite: 109 tests across 18 suites (100% passing).
  - **Files Created/Modified:**
    - `src/setup/types.ts` (created)
    - `src/setup/contextExtractor.ts` (created)
    - `src/setup/setupGenerator.ts` (created)
    - `src/setup/index.ts` (created)
    - `src/test/setupGenerator.test.ts` (created)
    - `PROJECT_STATUS.md` (updated)
  - **Verification:**
    - `npm run compile`: Compiled TypeScript cleanly with code 0.
    - `npm test`: 109/109 tests passing in 1.68s across 18 suites.
    - `npx @vscode/vsce ls`: Packaging manifest verified cleanly.

- **Milestone 9: Safe Setup Execution Agent**
  - Incrementally execute approved setup steps with strict security boundaries, capture results, compare against expected outcomes, and trigger bounded recovery when steps fail.
- **Milestone 10: LLM-Assisted Bug Analysis & Verified Fixes**
  - Ground diagnosis on actual check failures and source context, propose verified fixes for confirmed defects, and maintain rollback protections.
- **Milestone 11: LLM-Assisted Pull Request Preparation**
  - Draft evidence-backed commit messages, PR titles, and markdown summaries from verified diffs and test results.
- **Milestone 12: End-to-End Stress Testing & Final Presentation**
  - Validate end-to-end workflow on real-world repositories (Kolibri & demo fixture), harden error handling, package extension, and prepare demo and pitch collateral.

