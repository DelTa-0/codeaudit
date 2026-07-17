import { badRequest } from "./errors.js";

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * SSRF guard: only well-formed HTTPS GitHub repo URLs are accepted.
 * Returns the normalized "owner/repo" full name and clone URL.
 */
export function parseRepoUrl(input: string): { fullName: string; cloneUrl: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw badRequest("Not a valid URL");
  }
  if (url.protocol !== "https:") throw badRequest("Only HTTPS GitHub URLs are allowed");
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()))
    throw badRequest("Only github.com repositories are supported");
  if (url.username || url.password) throw badRequest("Credentials in URLs are not allowed");

  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw badRequest("URL must point to a repository (github.com/owner/repo)");
  const [owner, repo] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
    throw badRequest("Invalid repository path");

  const fullName = `${owner}/${repo}`;
  return { fullName, cloneUrl: `https://github.com/${fullName}.git` };
}
