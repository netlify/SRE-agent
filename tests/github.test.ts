import { describe, it, expect, vi, afterEach } from "vitest";
import { parseGithubUrl, fetchRepoContext } from "../src/github.js";

// ---------------------------------------------------------------------------
// parseGithubUrl — pure function, no mocks
// ---------------------------------------------------------------------------
describe("parseGithubUrl", () => {
  it("parses a clean URL", () => {
    expect(
      parseGithubUrl("https://github.com/netlify/compute-orchestrator")
    ).toEqual({ owner: "netlify", repo: "compute-orchestrator" });
  });

  it("handles trailing slash", () => {
    expect(
      parseGithubUrl("https://github.com/netlify/compute-orchestrator/")
    ).toEqual({ owner: "netlify", repo: "compute-orchestrator" });
  });

  it("strips .git suffix", () => {
    expect(
      parseGithubUrl("https://github.com/netlify/compute-orchestrator.git")
    ).toEqual({ owner: "netlify", repo: "compute-orchestrator" });
  });

  it("handles deep paths — takes only owner/repo", () => {
    expect(
      parseGithubUrl(
        "https://github.com/netlify/compute-orchestrator/tree/main/src"
      )
    ).toEqual({ owner: "netlify", repo: "compute-orchestrator" });
  });

  it("parses a URL embedded in a sentence", () => {
    const result = parseGithubUrl(
      "please build a readme for https://github.com/netlify/my-svc thanks"
    );
    expect(result).toEqual({ owner: "netlify", repo: "my-svc" });
  });

  it("returns null for a plain string with no URL", () => {
    expect(parseGithubUrl("just a service name")).toBeNull();
  });

  it("returns null for a non-GitHub URL", () => {
    expect(parseGithubUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseGithubUrl("")).toBeNull();
  });

  it("returns null for a URL with only the owner (no repo)", () => {
    expect(parseGithubUrl("https://github.com/netlify")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchRepoContext — mocked fetch
// ---------------------------------------------------------------------------
function b64(content: string): string {
  return Buffer.from(content).toString("base64");
}

function makeFileFetch(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: b64(content), encoding: "base64" }),
  };
}

const h = { get: () => null }; // stub headers
const okProbe = {
  ok: true,
  status: 200,
  json: async () => ({ name: "my-repo" }),
  headers: h,
};
const notFoundResponse = {
  ok: false,
  status: 404,
  json: async () => ({}),
  headers: h,
};
const unauthorizedResponse = {
  ok: false,
  status: 401,
  json: async () => ({}),
  headers: h,
};
const forbiddenResponse = {
  ok: false,
  status: 403,
  json: async () => ({ message: "Forbidden" }),
  headers: h,
};
const rateLimitResponse = {
  ok: false,
  status: 429,
  json: async () => ({}),
  headers: h,
};
const serverErrorResponse = {
  ok: false,
  status: 500,
  json: async () => ({}),
  headers: h,
};
const emptyDirResponse = {
  ok: true,
  status: 200,
  json: async () => [],
  headers: h,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRepoContext", () => {
  it("returns decoded file contents for successful fetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/repos/") && !url.includes("/contents"))
          return okProbe;
        if (url.includes("/contents/.github/workflows"))
          return emptyDirResponse;
        if (url.includes("README.md")) return makeFileFetch("# My Service");
        if (url.includes("package.json"))
          return makeFileFetch('{"name":"my-svc"}');
        return notFoundResponse;
      })
    );

    const ctx = await fetchRepoContext({ owner: "netlify", repo: "my-svc" });
    expect(ctx.files["README.md"]).toBe("# My Service");
    expect(ctx.files["package.json"]).toBe('{"name":"my-svc"}');
  });

  it("silently skips files that return 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/repos/") && !url.includes("/contents"))
          return okProbe;
        if (url.includes("/contents/.github/workflows"))
          return emptyDirResponse;
        return notFoundResponse;
      })
    );

    const ctx = await fetchRepoContext({ owner: "netlify", repo: "my-svc" });
    expect(Object.keys(ctx.files)).toHaveLength(0);
  });

  it("throws on 401 (authentication required)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unauthorizedResponse));
    await expect(
      fetchRepoContext({ owner: "netlify", repo: "private-svc" })
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("throws on 404 repo probe (repo not found)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notFoundResponse));
    await expect(
      fetchRepoContext({ owner: "netlify", repo: "no-such-repo" })
    ).rejects.toThrow(/not found/i);
  });

  it("throws on 429 (rate limited)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rateLimitResponse));
    await expect(
      fetchRepoContext({ owner: "netlify", repo: "my-svc" })
    ).rejects.toThrow(/rate limit/i);
  });

  it("throws on 5xx server error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(serverErrorResponse));
    await expect(
      fetchRepoContext({ owner: "netlify", repo: "my-svc" })
    ).rejects.toThrow(/GitHub API error/i);
  });

  it("truncates files longer than 8000 characters", async () => {
    const bigContent = "x".repeat(10000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/repos/") && !url.includes("/contents"))
          return okProbe;
        if (url.includes("/contents/.github/workflows"))
          return emptyDirResponse;
        if (url.includes("README.md")) return makeFileFetch(bigContent);
        return notFoundResponse;
      })
    );

    const ctx = await fetchRepoContext({ owner: "netlify", repo: "my-svc" });
    expect(ctx.files["README.md"].length).toBeLessThan(bigContent.length);
    expect(ctx.files["README.md"]).toContain("[truncated]");
  });

  it("includes Authorization header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "test-token-123";
    const calls: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        calls.push([
          url,
          (opts?.headers as Record<string, string>)?.["Authorization"] ?? "",
        ]);
        if (url.includes("/repos/") && !url.includes("/contents"))
          return okProbe;
        return notFoundResponse;
      })
    );

    try {
      await fetchRepoContext({ owner: "netlify", repo: "my-svc" });
    } finally {
      delete process.env.GITHUB_TOKEN;
    }

    const probeCall = calls.find(
      ([url]) =>
        url.includes("/repos/netlify/my-svc") && !url.includes("/contents")
    );
    expect(probeCall?.[1]).toBe("Bearer test-token-123");
  });

  it("omits Authorization header when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    const calls: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        calls.push([
          url,
          (opts?.headers as Record<string, string>)?.["Authorization"] ?? "",
        ]);
        if (url.includes("/repos/") && !url.includes("/contents"))
          return okProbe;
        return notFoundResponse;
      })
    );

    await fetchRepoContext({ owner: "netlify", repo: "my-svc" });
    const probeCall = calls.find(
      ([url]) =>
        url.includes("/repos/netlify/my-svc") && !url.includes("/contents")
    );
    expect(probeCall?.[1]).toBe("");
  });

  it("fetches .github/workflows yml files via directory listing", async () => {
    const workflowList = [
      {
        name: "deploy.yml",
        path: ".github/workflows/deploy.yml",
        type: "file",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/repos/") && !url.includes("/contents"))
          return okProbe;
        if (url.endsWith("/.github/workflows")) {
          return { ok: true, status: 200, json: async () => workflowList };
        }
        if (url.includes("deploy.yml"))
          return makeFileFetch("name: Deploy\non: push");
        return notFoundResponse;
      })
    );

    const ctx = await fetchRepoContext({ owner: "netlify", repo: "my-svc" });
    expect(ctx.files[".github/workflows/deploy.yml"]).toContain("Deploy");
  });

  // Suppress unused variable warning for forbiddenResponse (used as reference)
  it("throws on 403 access denied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(forbiddenResponse));
    await expect(
      fetchRepoContext({ owner: "netlify", repo: "private-svc" })
    ).rejects.toThrow(/private|access denied/i);
  });
});
