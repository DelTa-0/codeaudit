// Printable scan report. Rendered as a plain document (no app chrome) so the
// browser's own Save-as-PDF produces a clean file; the same data also feeds
// the Word export in lib/report.ts. Keep the two in sync when adding sections.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchReportData, downloadWordReport, type ReportData } from "../lib/report";
import { Button, Spinner, EmptyState } from "../components/ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="report-section mt-8">
      <h2 className="mb-2 border-b border-border pb-1 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ScanReport() {
  const { scanId } = useParams();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchReportData(scanId!)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load report"));
  }, [scanId]);

  if (error) return <EmptyState title="Report unavailable" hint={error} />;
  if (!data)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  const { scan, repo, dependencies, codeFindings, generatedAt } = data;
  const s = scan.summary;
  const vulnerable = dependencies.filter(
    (d) => (d.registry_metadata?.vulnerabilities?.length ?? 0) > 0,
  );
  // Secrets are persisted as code_findings rows too (confidence 1.0), so an
  // unfiltered dump would render them under "Dead-code findings" with the
  // credential provider standing in for a symbol name. Split into their own
  // section, matching ScanDetail.tsx's Secrets card and lib/report.ts's
  // Word-export equivalent.
  const secretFindings = codeFindings.filter((f) => f.finding_type.startsWith("hardcoded_secret"));
  const agentConfigFindings = codeFindings.filter((f) => f.finding_type.startsWith("agent_"));
  const deadCodeFindings = codeFindings.filter(
    (f) => !f.finding_type.startsWith("hardcoded_secret") && !f.finding_type.startsWith("agent_"),
  );

  return (
    <div className="report-page mx-auto max-w-4xl px-6 py-8">
      {/* Controls — hidden from the printed/PDF output */}
      <div className="no-print mb-8 flex flex-wrap items-center gap-3">
        <Link to={`/scans/${scan.id}`} className="text-sm text-muted hover:underline">
          ← Back to scan
        </Link>
        <div className="flex-1" />
        <Button onClick={() => window.print()}>Save as PDF</Button>
        <Button variant="ghost" onClick={() => downloadWordReport(data)}>
          Download Word
        </Button>
      </div>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">CodeAudit scan report</h1>
        <p className="mt-2 text-sm text-muted">
          <span className="font-mono font-medium text-foreground">
            {repo?.full_name ?? "Unknown repository"}
          </span>
          <br />
          Trigger: {scan.trigger}
          {scan.branch && <> · Branch: {scan.branch}</>}
          {scan.commit_sha && <> · Commit: {scan.commit_sha.slice(0, 7)}</>}
          <br />
          Scan started: {new Date(scan.created_at).toLocaleString()}
          <br />
          Report generated: {generatedAt.toLocaleString()}
        </p>
      </header>

      {s?.reviewStatus && s.reviewStatus !== "full" && (
        <p className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <b>Static-only score.</b> Dead-code findings were not verified by the LLM review pass, so
          they are unfiltered candidates and this score is noisier than an LLM-verified scan.
        </p>
      )}

      {s && (
        <Section title="Summary">
          <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible print:mx-0 print:px-0">
          <table className="report-table w-full min-w-[520px] text-sm sm:min-w-0 print:min-w-0">
            <tbody>
              {(
                [
                  ["Health score", `${s.score} (${s.grade})`],
                  ["Hardcoded secrets", s.counts.secrets ?? 0],
                  ["Phantom dependencies", s.counts.phantom],
                  ["Known vulnerabilities", s.counts.vulnerable ?? 0],
                  ["Suspicious packages", s.counts.suspicious],
                  ["Unused dependencies", s.counts.unused],
                  ["Dead-code findings", s.counts.zombies],
                  ["Files analysed", s.counts.filesAnalyzed],
                ] as const
              ).map(([label, value]) => (
                <tr key={label}>
                  <td className="py-1 pr-4 text-muted">{label}</td>
                  <td className="py-1 font-mono font-medium">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Section>
      )}

      {vulnerable.length > 0 && (
        <Section title={`Known vulnerabilities (${vulnerable.length})`}>
          <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible print:mx-0 print:px-0">
          <table className="report-table w-full min-w-[520px] text-sm sm:min-w-0 print:min-w-0">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-1 font-medium">Package</th>
                <th className="pb-1 font-medium">Version</th>
                <th className="pb-1 font-medium">Severity</th>
                <th className="pb-1 font-medium">Advisories</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {vulnerable.map((d) => (
                <tr key={d.id}>
                  <td className="py-1 font-mono">{d.package_name}</td>
                  <td className="py-1 font-mono text-muted">{d.declared_version ?? "—"}</td>
                  <td className="py-1 uppercase">{d.registry_metadata?.maxSeverity ?? "unknown"}</td>
                  <td className="py-1 text-xs">
                    {(d.registry_metadata?.vulnerabilities ?? []).map((v) => v.id).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Section>
      )}

      <Section title={`Dependencies (${dependencies.length})`}>
        <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible print:mx-0 print:px-0">
          <table className="report-table w-full min-w-[520px] text-sm sm:min-w-0 print:min-w-0">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="pb-1 font-medium">Package</th>
              <th className="pb-1 font-medium">Version</th>
              <th className="pb-1 font-medium">Status</th>
              <th className="pb-1 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {dependencies.map((d) => {
              const notes: string[] = [];
              if (d.registry_metadata?.typosquatOf)
                notes.push(`looks like ${d.registry_metadata.typosquatOf}`);
              if (d.registry_metadata?.transitive) notes.push("transitive");
              return (
                <tr key={d.id}>
                  <td className="py-1 font-mono">{d.package_name}</td>
                  <td className="py-1 font-mono text-muted">{d.declared_version ?? "—"}</td>
                  <td className="py-1">{d.status}</td>
                  <td className="py-1 text-xs text-muted">{notes.join("; ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
          </div>
      </Section>

      {secretFindings.length > 0 && (
        <Section title={`Hardcoded secrets (${secretFindings.length})`}>
          <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible print:mx-0 print:px-0">
          <table className="report-table w-full min-w-[520px] text-sm sm:min-w-0 print:min-w-0">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-1 font-medium">Provider</th>
                <th className="pb-1 font-medium">Location</th>
                <th className="pb-1 font-medium">Guidance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {secretFindings.map((f) => {
                const detail = f.detail && "provider" in f.detail ? f.detail : null;
                return (
                  <tr key={f.id}>
                    <td className="py-1 font-mono">{detail?.provider ?? "Unknown provider"}</td>
                    <td className="py-1 font-mono text-xs text-muted">
                      {f.file_path}
                      {f.line_start ? `:${f.line_start}` : ""}
                    </td>
                    <td className="py-1 text-xs text-muted">
                      {detail?.removedFromHead
                        ? "Still recoverable from git history — rotate this credential. Deleting the file does not revoke it."
                        : "Remove this from source, then rotate the credential."}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Section>
      )}

      {agentConfigFindings.length > 0 && (
        <Section title={`Agent config risks (${agentConfigFindings.length})`}>
          <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible print:mx-0 print:px-0">
          <table className="report-table w-full min-w-[520px] text-sm sm:min-w-0 print:min-w-0">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-1 font-medium">Rule</th>
                <th className="pb-1 font-medium">Severity</th>
                <th className="pb-1 font-medium">Location</th>
                <th className="pb-1 font-medium">Guidance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agentConfigFindings.map((f) => {
                const detail = f.detail && "rule" in f.detail ? f.detail : null;
                return (
                  <tr key={f.id}>
                    <td className="py-1 font-mono">{detail?.rule ?? f.finding_type}</td>
                    <td className="py-1 text-xs text-muted">{detail?.severity ?? "—"}</td>
                    <td className="py-1 font-mono text-xs text-muted">
                      {f.file_path}
                      {f.line_start ? `:${f.line_start}` : ""}
                    </td>
                    <td className="py-1 text-xs text-muted">{f.llm_reasoning ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Section>
      )}

      <Section title={`Dead-code findings (${deadCodeFindings.length})`}>
        {deadCodeFindings.length === 0 ? (
          <p className="text-sm text-muted">None detected.</p>
        ) : (
          <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible print:mx-0 print:px-0">
          <table className="report-table w-full min-w-[520px] text-sm sm:min-w-0 print:min-w-0">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-1 font-medium">Symbol</th>
                <th className="pb-1 font-medium">Location</th>
                <th className="pb-1 font-medium">Confidence</th>
                <th className="pb-1 font-medium">Reasoning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deadCodeFindings.map((f) => (
                <tr key={f.id}>
                  <td className="py-1 font-mono">{f.symbol_name ?? "(anonymous)"}</td>
                  <td className="py-1 font-mono text-xs text-muted">
                    {f.file_path}
                    {f.line_start ? `:${f.line_start}` : ""}
                  </td>
                  <td className="py-1 font-mono">
                    {f.confidence_score !== null
                      ? `${Math.round(Number(f.confidence_score) * 100)}%`
                      : "—"}
                  </td>
                  <td className="py-1 text-xs text-muted">{f.llm_reasoning}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Section>

      <footer className="mt-10 border-t border-border pt-3 text-xs text-muted">
        Generated by CodeAudit. Automated analysis — verify findings before acting on them.
        Dependency verdicts reflect the public registry and advisory data at scan time.
      </footer>
    </div>
  );
}
