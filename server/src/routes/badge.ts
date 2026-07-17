import { Router } from "express";
import crypto from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { notFound } from "../lib/errors.js";
import { logAudit } from "../services/audit.js";
import { config } from "../lib/config.js";

/** Public badge route — no auth (README-embeddable), keyed by unguessable token. */
export const publicBadgeRouter = Router();

function badgeSvg(label: string, value: string, color: string): string {
  // Shields-flat style. Widths approximated from character counts (6.5px/char + padding).
  const labelWidth = Math.round(label.length * 6.5) + 14;
  const valueWidth = Math.round(value.length * 6.5) + 14;
  const total = labelWidth + valueWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>
  </g>
</svg>`;
}

publicBadgeRouter.get("/badge/:token.svg", async (req, res, next) => {
  try {
    const repo = await queryOne<{ latest_score: string | null }>(
      "SELECT latest_score FROM repositories WHERE badge_token = $1",
      [req.params.token],
    );
    if (!repo) return res.status(404).type("image/svg+xml").send(badgeSvg("codeaudit", "not found", "#9f9f9f"));

    const score = repo.latest_score !== null ? Number(repo.latest_score) : null;
    const value =
      score === null
        ? "unscanned"
        : `${score} ${score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F"}`;
    const color =
      score === null ? "#9f9f9f" : score >= 75 ? "#4c1" : score >= 50 ? "#dfb317" : "#e05d44";

    res
      .type("image/svg+xml")
      .setHeader("Cache-Control", "public, max-age=300")
      .send(badgeSvg("codeaudit", value, color));
  } catch (err) {
    next(err);
  }
});

/** Authed badge management — generates the token + markdown snippet. */
export const badgeRouter = Router();
badgeRouter.use(requireAuth);

badgeRouter.post("/repos/:repoId/badge", async (req, res, next) => {
  try {
    const repo = await queryOne<{ id: string; org_id: string; badge_token: string | null; role: string }>(
      `SELECT r.id, r.org_id, r.badge_token, m.role FROM repositories r
       JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
       WHERE r.id = $1`,
      [req.params.repoId, req.user!.id],
    );
    if (!repo) throw notFound("Repository not found");
    if (repo.role === "developer") throw notFound("Repository not found"); // admin+ only

    let token = repo.badge_token;
    if (!token) {
      token = crypto.randomBytes(16).toString("hex");
      await query("UPDATE repositories SET badge_token = $2 WHERE id = $1", [repo.id, token]);
      await logAudit(repo.org_id, req.user!.id, "badge.created", repo.id);
    }
    const url = `${config.apiUrl}/api/badge/${token}.svg`;
    res.json({ token, url, markdown: `[![CodeAudit](${url})](${config.appUrl})` });
  } catch (err) {
    next(err);
  }
});
