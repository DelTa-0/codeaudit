// Scan-report export. Two output paths from one data source:
//   - PDF  : the /scans/:id/report route renders a print-optimised document
//            and the browser's own "Save as PDF" produces the file.
//   - Word : buildWordHtml() below emits Word-namespaced HTML served as a
//            .doc blob. Word, Google Docs and LibreOffice all open this
//            natively and it stays editable, so no document-generation
//            dependency is needed. Deliberate: CodeAudit's whole job is
//            flagging dependency weight, so adding ~1MB of OOXML tooling for
//            one export would be self-inflicted irony. If Word-compatibility
//            complaints ever appear, swapping this for the `docx` package is
//            a contained change — only this file produces the document.
import { api, type Scan, type Repo, type DependencyFinding, type CodeFinding } from "./api";

export interface ReportData {
  scan: Scan;
  repo: Repo | null;
  dependencies: DependencyFinding[];
  codeFindings: CodeFinding[];
  generatedAt: Date;
}

const PER_PAGE = 100; // server caps per_page at 100

/** Fetch every page so the exported report isn't silently truncated. */
async function fetchAllPages<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await api<T[]>(`${path}?page=${page}&per_page=${PER_PAGE}`);
    out.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

export async function fetchReportData(scanId: string): Promise<ReportData> {
  const scan = await api<Scan>(`/api/scans/${scanId}`);
  const [dependencies, codeFindings, repo] = await Promise.all([
    fetchAllPages<DependencyFinding>(`/api/scans/${scanId}/dependencies`),
    fetchAllPages<CodeFinding>(`/api/scans/${scanId}/code-findings`),
    scan.repo_id ? api<Repo>(`/api/repos/${scan.repo_id}`).catch(() => null) : Promise.resolve(null),
  ]);
  return { scan, repo, dependencies, codeFindings, generatedAt: new Date() };
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function reportFileBase(data: ReportData): string {
  const repo = (data.repo?.full_name ?? "scan").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const date = data.generatedAt.toISOString().slice(0, 10);
  return `codeaudit-${repo}-${date}`;
}

/** Word-compatible HTML document (opens in Word / Google Docs / LibreOffice). */
export function buildWordHtml(data: ReportData): string {
  const { scan, repo, dependencies, codeFindings, generatedAt } = data;
  const s = scan.summary;
  const vulnerable = dependencies.filter(
    (d) => (d.registry_metadata?.vulnerabilities?.length ?? 0) > 0,
  );

  const row = (cells: string[], tag: "td" | "th" = "td") =>
    `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;

  const countsTable = s
    ? `<table class="grid"><tbody>
${row(["Health score", `${s.score} (${s.grade})`])}
${row(["Phantom dependencies", String(s.counts.phantom)])}
${row(["Known vulnerabilities", String(s.counts.vulnerable ?? 0)])}
${row(["Suspicious packages", String(s.counts.suspicious)])}
${row(["Unused dependencies", String(s.counts.unused)])}
${row(["Dead-code findings", String(s.counts.zombies)])}
${row(["Files analysed", String(s.counts.filesAnalyzed)])}
</tbody></table>`
    : "<p>No summary available for this scan.</p>";

  const vulnSection = vulnerable.length
    ? `<h2>Known vulnerabilities (${vulnerable.length})</h2>
<table class="grid"><thead>${row(["Package", "Version", "Severity", "Advisories"], "th")}</thead><tbody>
${vulnerable
  .map((d) =>
    row([
      esc(d.package_name),
      esc(d.declared_version ?? "—"),
      esc((d.registry_metadata?.maxSeverity ?? "unknown").toUpperCase()),
      esc(
        (d.registry_metadata?.vulnerabilities ?? [])
          .map((v) => `${v.id}${v.aliases.length ? ` (${v.aliases.join(", ")})` : ""}`)
          .join("; "),
      ),
    ]),
  )
  .join("\n")}
</tbody></table>`
    : "";

  const depsTable = `<h2>Dependencies (${dependencies.length})</h2>
<table class="grid"><thead>${row(["Package", "Ecosystem", "Version", "Status", "Notes"], "th")}</thead><tbody>
${dependencies
  .map((d) => {
    const notes: string[] = [];
    if (d.registry_metadata?.typosquatOf)
      notes.push(`looks like ${d.registry_metadata.typosquatOf} — possible slopsquat`);
    if (d.registry_metadata?.transitive) notes.push("transitive");
    if (typeof d.registry_metadata?.weeklyDownloads === "number")
      notes.push(`${d.registry_metadata.weeklyDownloads.toLocaleString()} downloads`);
    return row([
      esc(d.package_name),
      esc(d.ecosystem),
      esc(d.declared_version ?? "—"),
      esc(d.status),
      esc(notes.join("; ")),
    ]);
  })
  .join("\n")}
</tbody></table>`;

  const findingsSection = codeFindings.length
    ? `<h2>Dead-code findings (${codeFindings.length})</h2>
<table class="grid"><thead>${row(["Symbol", "Location", "Type", "Confidence", "Reasoning"], "th")}</thead><tbody>
${codeFindings
  .map((f) =>
    row([
      esc(f.symbol_name ?? "(anonymous)"),
      esc(`${f.file_path}${f.line_start ? `:${f.line_start}` : ""}`),
      esc(f.finding_type),
      f.confidence_score !== null ? `${Math.round(Number(f.confidence_score) * 100)}%` : "—",
      esc(f.llm_reasoning ?? ""),
    ]),
  )
  .join("\n")}
</tbody></table>`
    : "<h2>Dead-code findings</h2><p>None detected.</p>";

  const staticOnly =
    s?.reviewStatus && s.reviewStatus !== "full"
      ? `<p class="note"><b>Static-only score.</b> Dead-code findings in this scan were not verified
by the LLM review pass, so they are unfiltered candidates and this score is noisier than an
LLM-verified scan.</p>`
      : "";

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>CodeAudit report — ${esc(repo?.full_name ?? "")}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #111; }
  h1 { font-size: 20pt; margin-bottom: 2pt; }
  h2 { font-size: 14pt; margin-top: 18pt; border-bottom: 1px solid #999; padding-bottom: 3pt; }
  .meta { color: #555; font-size: 10pt; margin-top: 0; }
  table.grid { border-collapse: collapse; width: 100%; margin-top: 6pt; }
  table.grid td, table.grid th { border: 1px solid #999; padding: 4pt 6pt; font-size: 10pt;
    text-align: left; vertical-align: top; }
  table.grid th { background: #eee; font-weight: bold; }
  .note { background: #fff6e5; border: 1px solid #e0b050; padding: 6pt; font-size: 10pt; }
  .footer { margin-top: 20pt; color: #555; font-size: 9pt; border-top: 1px solid #999; padding-top: 6pt; }
</style></head>
<body>
<h1>CodeAudit scan report</h1>
<p class="meta">
  <b>${esc(repo?.full_name ?? "Unknown repository")}</b><br>
  Scan ${esc(scan.id)}<br>
  Trigger: ${esc(scan.trigger)}${scan.branch ? ` · Branch: ${esc(scan.branch)}` : ""}${
    scan.commit_sha ? ` · Commit: ${esc(scan.commit_sha.slice(0, 7))}` : ""
  }<br>
  Scan started: ${esc(new Date(scan.created_at).toLocaleString())}<br>
  Report generated: ${esc(generatedAt.toLocaleString())}
</p>
${staticOnly}
<h2>Summary</h2>
${countsTable}
${vulnSection}
${depsTable}
${findingsSection}
<p class="footer">Generated by CodeAudit. Automated analysis — verify findings before acting on
them. Dependency verdicts reflect the public registry and advisory data at scan time.</p>
</body></html>`;
}

/** Triggers a .doc download in the browser. */
export function downloadWordReport(data: ReportData) {
  const blob = new Blob(["﻿", buildWordHtml(data)], {
    type: "application/msword;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${reportFileBase(data)}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
