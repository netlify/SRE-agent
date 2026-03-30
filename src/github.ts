const GITHUB_API = "https://api.github.com";
const MAX_FILE_BYTES = 8000;
const MAX_WORKFLOW_FILES = 3;

export interface RepoCoordinates {
  owner: string;
  repo: string;
}

export interface RepoContext {
  owner: string;
  repo: string;
  files: Record<string, string>; // path → decoded content (truncated to MAX_FILE_BYTES)
}

// Files to attempt fetching, in priority order
const CANDIDATE_FILES = [
  "README.md",
  "package.json",
  "go.mod",
  "docker-compose.yml",
  "Makefile",
  "Dockerfile",
  "requirements.txt",
  "pyproject.toml",
];

export function parseGithubUrl(text: string): RepoCoordinates | null {
  const match = text.match(/github\.com\/([^/#?.\s]+)\/([^/#?.\s]+)/);
  if (!match) return null;
  const repo = match[2].replace(/\.git$/, "");
  if (!repo) return null;
  return { owner: match[1], repo };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sre-agent",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function decodeContent(content: string): string {
  const decoded = Buffer.from(content.replace(/\n/g, ""), "base64").toString(
    "utf-8"
  );
  return decoded.length > MAX_FILE_BYTES
    ? decoded.slice(0, MAX_FILE_BYTES) + "\n[truncated]"
    : decoded;
}

export async function fetchRepoContext(
  coords: RepoCoordinates
): Promise<RepoContext> {
  const { owner, repo } = coords;
  let headers = githubHeaders();

  // Probe the repo first — distinguishes not-found from private
  let probeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers,
  });

  if (probeRes.status === 401) {
    if (process.env.GITHUB_TOKEN) {
      const unauthHeaders: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sre-agent",
      };
      const retryRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
        headers: unauthHeaders,
      });
      if (retryRes.ok) {
        console.warn(
          "[sre-agent] GITHUB_TOKEN is invalid or expired — proceeding without authentication (public repos only)"
        );
        headers = unauthHeaders;
        probeRes = retryRes;
      } else {
        throw new Error(
          `GitHub returned 401 — your GITHUB_TOKEN may be invalid or expired. Check it at github.com/settings/tokens.`
        );
      }
    } else {
      throw new Error(
        `This repository requires authentication. Set GITHUB_TOKEN in your .env file.`
      );
    }
  }

  if (probeRes.status === 403) {
    const remaining = probeRes.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new Error(
        `GitHub API rate limit exceeded. Set GITHUB_TOKEN in your .env to get a higher limit.`
      );
    }
    const body = (await probeRes.json().catch(() => ({}))) as {
      message?: string;
    };
    if (body?.message?.toLowerCase().includes("rate limit")) {
      throw new Error(
        `GitHub API rate limit exceeded. Set GITHUB_TOKEN in your .env to get a higher limit.`
      );
    }
    throw new Error(
      `Access denied for ${owner}/${repo}. The repository may be private — set GITHUB_TOKEN in your .env file.`
    );
  }

  if (probeRes.status === 404) {
    throw new Error(
      `Repository ${owner}/${repo} not found. Check the URL and make sure it is public (or set GITHUB_TOKEN).`
    );
  }

  if (probeRes.status === 429) {
    throw new Error(
      `GitHub API rate limit exceeded. Set GITHUB_TOKEN in your .env to get a higher limit.`
    );
  }

  if (!probeRes.ok) {
    throw new Error(
      `GitHub API error ${probeRes.status} fetching repo metadata.`
    );
  }

  const files: Record<string, string> = {};

  // Fetch candidate files in parallel
  await Promise.allSettled(
    CANDIDATE_FILES.map(async (path) => {
      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
        { headers }
      );
      if (!res.ok) return; // 404 = file doesn't exist, silently skip
      const data = (await res.json()) as {
        content?: string;
        encoding?: string;
      };
      if (data.content && data.encoding === "base64") {
        files[path] = decodeContent(data.content);
      }
    })
  );

  // Also fetch .github/workflows (list then fetch each file)
  try {
    const wfRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/.github/workflows`,
      { headers }
    );
    if (wfRes.ok) {
      const entries = (await wfRes.json()) as Array<{
        name: string;
        path: string;
        type: string;
      }>;
      if (Array.isArray(entries)) {
        const ymlFiles = entries
          .filter((e) => e.type === "file" && e.name.endsWith(".yml"))
          .slice(0, MAX_WORKFLOW_FILES);
        await Promise.allSettled(
          ymlFiles.map(async (entry) => {
            const res = await fetch(
              `${GITHUB_API}/repos/${owner}/${repo}/contents/${entry.path}`,
              { headers }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              content?: string;
              encoding?: string;
            };
            if (data.content && data.encoding === "base64") {
              files[entry.path] = decodeContent(data.content);
            }
          })
        );
      }
    }
  } catch {
    /* workflows directory missing — not an error */
  }

  return { owner, repo, files };
}
