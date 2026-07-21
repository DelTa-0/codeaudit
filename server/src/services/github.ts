import crypto from "node:crypto";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import { config } from "../lib/config.js";

const GITHUB_API = "https://api.github.com";

export function githubConfigured(): boolean {
  return Boolean(config.github.appId && config.github.privateKeyPath);
}

function appJwt(): string {
  const privateKey = fs.readFileSync(config.github.privateKeyPath, "utf8");
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: config.github.appId }, privateKey, {
    algorithm: "RS256",
  });
}

async function githubFetch(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${path}`);
  return res.json();
}

/** Short-lived installation token — used for private clones and PR comments. */
export async function getInstallationToken(installationId: number): Promise<string> {
  const data = (await githubFetch(
    `/app/installations/${installationId}/access_tokens`,
    appJwt(),
    { method: "POST" },
  )) as { token: string };
  return data.token;
}

export async function listInstallationRepos(installationId: number) {
  const token = await getInstallationToken(installationId);
  const data = (await githubFetch(`/installation/repositories?per_page=100`, token)) as {
    repositories: {
      id: number;
      full_name: string;
      private: boolean;
      default_branch: string;
    }[];
  };
  return data.repositories.map((r) => ({
    githubRepoId: r.id,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
  }));
}

export function authenticatedCloneUrl(fullName: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${fullName}.git`;
}

const STICKY_MARKER = "<!-- codeaudit-sticky-comment -->";

/** Posts or updates a single sticky PR comment (upsert keyed by hidden marker). */
export async function upsertPrComment(
  installationId: number,
  fullName: string,
  prNumber: number,
  body: string,
) {
  const token = await getInstallationToken(installationId);
  const marked = `${STICKY_MARKER}\n${body}`;
  const comments = (await githubFetch(
    `/repos/${fullName}/issues/${prNumber}/comments?per_page=100`,
    token,
  )) as { id: number; body?: string }[];
  const existing = comments.find((c) => c.body?.includes(STICKY_MARKER));
  if (existing) {
    await githubFetch(`/repos/${fullName}/issues/comments/${existing.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ body: marked }),
    });
  } else {
    await githubFetch(`/repos/${fullName}/issues/${prNumber}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body: marked }),
    });
  }
}

/**
 * Posts a GitHub Check Run for the merge gate. Requires the App's
 * "Checks: read & write" permission. Whether this blocks merges is the
 * repo owner's decision via branch protection — we only report.
 */
export async function createCheckRun(
  installationId: number,
  fullName: string,
  headSha: string,
  opts: {
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
  },
) {
  const token = await getInstallationToken(installationId);
  await githubFetch(`/repos/${fullName}/check-runs`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "CodeAudit",
      head_sha: headSha,
      status: "completed",
      conclusion: opts.conclusion,
      output: { title: opts.title, summary: opts.summary },
    }),
  });
}

// ---- Content/branch/PR helpers (used by the opt-in autofix job) ----

export async function getDefaultBranchSha(
  installationId: number,
  fullName: string,
  branch: string,
): Promise<string> {
  const token = await getInstallationToken(installationId);
  const data = (await githubFetch(`/repos/${fullName}/git/ref/heads/${branch}`, token)) as {
    object: { sha: string };
  };
  return data.object.sha;
}

export async function createBranch(
  installationId: number,
  fullName: string,
  branchName: string,
  fromSha: string,
) {
  const token = await getInstallationToken(installationId);
  await githubFetch(`/repos/${fullName}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
  });
}

export async function getFileContents(
  installationId: number,
  fullName: string,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string }> {
  const token = await getInstallationToken(installationId);
  const data = (await githubFetch(
    `/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    token,
  )) as { content: string; sha: string };
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

export async function updateFile(
  installationId: number,
  fullName: string,
  path: string,
  opts: { branch: string; message: string; content: string; sha: string },
) {
  const token = await getInstallationToken(installationId);
  await githubFetch(`/repos/${fullName}/contents/${path}`, token, {
    method: "PUT",
    body: JSON.stringify({
      message: opts.message,
      content: Buffer.from(opts.content, "utf8").toString("base64"),
      branch: opts.branch,
      sha: opts.sha,
    }),
  });
}

export async function createPullRequest(
  installationId: number,
  fullName: string,
  opts: { title: string; head: string; base: string; body: string },
): Promise<{ number: number; htmlUrl: string }> {
  const token = await getInstallationToken(installationId);
  const data = (await githubFetch(`/repos/${fullName}/pulls`, token, {
    method: "POST",
    body: JSON.stringify(opts),
  })) as { number: number; html_url: string };
  return { number: data.number, htmlUrl: data.html_url };
}

export async function listOpenPullsByHeadPrefix(
  installationId: number,
  fullName: string,
  headPrefix: string,
): Promise<number[]> {
  const token = await getInstallationToken(installationId);
  const data = (await githubFetch(`/repos/${fullName}/pulls?state=open&per_page=100`, token)) as {
    number: number;
    head: { ref: string };
  }[];
  return data.filter((p) => p.head.ref.startsWith(headPrefix)).map((p) => p.number);
}

/** Constant-time HMAC verification of X-Hub-Signature-256. */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!config.github.webhookSecret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.github.webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- OAuth (user sign-in) ----

export function oauthAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: `${config.apiUrl}/api/auth/github/callback`,
    state,
    scope: "read:user user:email",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeOauthCode(code: string): Promise<{
  githubUserId: number;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) throw new Error("GitHub OAuth code exchange failed");

  const user = (await githubFetch("/user", tokenData.access_token)) as {
    id: number;
    email: string | null;
    name: string | null;
    avatar_url: string | null;
  };
  let email = user.email;
  if (!email) {
    try {
      const emails = (await githubFetch("/user/emails", tokenData.access_token)) as {
        email: string;
        primary: boolean;
        verified: boolean;
      }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
    } catch (err) {
      // Requires the App's "Email addresses" account permission (Read-only).
      // Without it this 403s — fall back to no-email rather than failing the login.
      console.error("GitHub /user/emails failed (check App account permissions):", err);
    }
  }
  return { githubUserId: user.id, email, name: user.name, avatarUrl: user.avatar_url };
}
