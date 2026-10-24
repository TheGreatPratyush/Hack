# FirstPR

> **Guided, local-first open source repository onboarding, safe setup execution, and evidence-backed pull request preparation inside VS Code.**

FirstPR turns the intimidating process of contributing to unfamiliar open-source repositories into a structured, transparent, and safe pair-programming workflow.

---

## 🚀 Key Features & Capabilities

1. **Safe Workspace Management & URL Validation**
   - Validates public GitHub repositories (`https://github.com/owner/repo`).
   - Clones into a clean, isolated local directory (`~/FirstPR/repositories/<owner>-<repo>`) or safely prompts to reuse an existing verified clone.
   - Prevents path traversal, unauthorized overwriting, and symlink escapes.

2. **Multi-Language Manifest & Context Extraction**
   - Detects runtimes and tools: **Node.js** (npm, yarn, pnpm, bun), **Python** (pip, poetry), and **Ruby** (Bundler).
   - Inspects manifests (`package.json`, `Gemfile`, `requirements.txt`, `.tool-versions`, `.ruby-version`, `.nvmrc`).
   - Safely parses oversized lockfiles (`yarn.lock`, `pnpm-lock.yaml`) via head streaming without memory bloat.

3. **Interactive Setup Orchestrator & Approval Gate**
   - Evaluates host environment prerequisites (Node, Yarn, pnpm, Ruby, Bundler, Python, Docker, Database configs).
   - Identifies version mismatches and missing dependencies with platform-safe remediation advice.
   - Generates an ordered execution runbook with explicit developer approval gates for every step.
   - Executes approved installation commands safely via bounded runners (`shell: false`), rejecting shell metacharacters and arbitrary code evaluation.
   - Conducts post-install verification and provides recovery fallbacks if a step fails.

4. **Non-Hallucinating Diagnostic Engine**
   - Analyzes real stdout, stderr, and exit codes from test and build runners.
   - Distinguishes **environment/tooling failures** (e.g. `jest: command not found`, missing Ruby gems) from **source code defects**.
   - **Refuses to hallucinate code patches** when dependencies or runtimes are missing.

5. **Verified Fix Engine & Safe Rollback**
   - For confirmed assertion or syntax errors, generates unified diffs for developer review.
   - Enforces SHA-256 pre-flight hashing to ensure target files have not drifted.
   - Zero file modifications prior to explicit user approval.
   - Automatically executes a re-check to verify if the patch resolved the problem.
   - One-click safe rollback restores original content without affecting other files.

6. **Evidence-Backed PR Preparation**
   - Formulates structured, evidence-grounded pull request drafts containing observed failures, verified fixes, and test results.
   - Redacts sensitive credentials (GitHub PATs, API keys, Bearer tokens, PEM private keys).
   - Automates Git branch creation on an isolated feature branch (`firstpr/<fix-slug>`) and stages only approved files.
   - Generates a pre-filled GitHub Compare & Review URL.

---

## 🛡️ Safety & Security Model

FirstPR is engineered with a strict **Local-First, Zero-Surprises** security posture:
- **100% Local Inference:** Integrates with local LLM daemons (e.g. Ollama with `qwen2.5-coder:7b` or `qwen3:8b`). No code or context is ever transmitted to third-party cloud APIs.
- **Offline Deterministic Fallbacks:** If the local LLM is offline or returns invalid schema, FirstPR automatically activates factual heuristic planners and rule-based diagnostic engines.
- **Process Isolation:** All subprocesses execute via `child_process.spawn` using strict argument vectors without shell evaluation.
- **Git Protection:** Never modifies the default branch directly, never creates remote branches or PRs without explicit confirmation, and never pushes upstream without developer consent.

---

## ⚠️ Known Limitations

- **Host Runtimes:** FirstPR runs checks using the host machine's installed tools. If a repository requires a specific compiler or runtime version not present on the host (e.g. Ruby 4.0.2 on macOS system Ruby 2.6.10, or Docker services), FirstPR identifies the missing dependency rather than attempting unsafe root installations.
- **Deterministic Fix Scope:** Automated fix proposals currently target verified assertion discrepancies, type mismatches, and syntax errors. Complex algorithmic bugs or multi-file architectural refactors require developer guidance.

---

## 🛠️ Development & Installation

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0
- Visual Studio Code >= 1.85.0
- *(Optional)* [Ollama](https://ollama.com) running locally (`ollama run qwen2.5-coder:7b`)

### Build & Test
```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run the complete test suite (142 tests across 22 suites)
npm test
```

### Launch in VS Code
Press `F5` in VS Code or run:
```bash
code --extensionDevelopmentPath=.
```

### Packaging VSIX
```bash
npx @vscode/vsce package
```
