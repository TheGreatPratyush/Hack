export interface ValidationSuccess {
  isValid: true;
  normalizedUrl: string;
  owner: string;
  repo: string;
  message: string;
}

export interface ValidationFailure {
  isValid: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

const GITHUB_USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Validates and normalizes a public GitHub repository HTTPS URL.
 */
export function validateGitHubUrl(rawInput: string | null | undefined): ValidationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      isValid: false,
      error: 'Repository URL cannot be empty.',
    };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: 'Repository URL cannot be empty.',
    };
  }

  // Reject shell metacharacters, spaces, or local filesystem indicators
  if (/[\s;`$|&><\\]/.test(trimmed)) {
    return {
      isValid: false,
      error: 'Input contains invalid characters or command syntax.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isValid: false,
      error: 'Malformed URL. Please enter a valid URL, e.g. https://github.com/owner/repository',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      isValid: false,
      error: 'Only secure HTTPS GitHub URLs are supported (e.g. https://github.com/owner/repository).',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return {
      isValid: false,
      error: `Unsupported host "${parsed.hostname}". Only public GitHub repositories (github.com) are supported.`,
    };
  }

  // Split path into segments, ignoring leading/trailing/multiple slashes
  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return {
      isValid: false,
      error: 'Missing owner and repository name in URL.',
    };
  }

  if (segments.length === 1) {
    return {
      isValid: false,
      error: 'URL is missing the repository name.',
    };
  }

  if (segments.length > 2) {
    return {
      isValid: false,
      error: 'URL contains extra subpaths. Please provide the root repository URL (https://github.com/owner/repository).',
    };
  }

  const [rawOwner, rawRepo] = segments;

  if (!GITHUB_USERNAME_REGEX.test(rawOwner)) {
    return {
      isValid: false,
      error: `Invalid GitHub owner or organization name: "${rawOwner}".`,
    };
  }

  let repoName = rawRepo;
  if (repoName.toLowerCase().endsWith('.git')) {
    repoName = repoName.slice(0, -4);
  }

  if (!GITHUB_REPO_REGEX.test(repoName) || repoName === '.' || repoName === '..') {
    return {
      isValid: false,
      error: `Invalid GitHub repository name: "${rawRepo}".`,
    };
  }

  const normalizedUrl = `https://github.com/${rawOwner}/${repoName}`;

  return {
    isValid: true,
    normalizedUrl,
    owner: rawOwner,
    repo: repoName,
    message: 'Repository URL validated successfully.',
  };
}
