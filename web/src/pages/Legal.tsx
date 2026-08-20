import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { ThemeToggle } from "../components/ThemeToggle";
import { LogoMark } from "../components/Logo";

/**
 * Privacy and terms.
 *
 * Written from what the code actually does rather than from a template, because
 * the only version of this document worth having is one that is true. Every
 * claim below is checkable against the repository: the retention windows are
 * the env vars the sweep reads, the sub-processor list is the set of services
 * the server actually calls, and the note about redaction is the contract
 * enforced in packages/engine/src/secrets.ts.
 *
 * That also makes it maintainable in the only way that matters — when the code
 * changes, the untrue sentence is findable.
 */
function LegalShell({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="relative min-h-screen px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="mx-auto w-full max-w-2xl">
        <Link to="/" className="mb-8 flex items-center gap-2 font-mono text-lg font-semibold tracking-tight">
          <span className="text-primary">
            <LogoMark size={22} />
          </span>
          CodeAudit
        </Link>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">Last updated {updated}</p>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-foreground/90 [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
          {children}
        </div>
        <p className="mt-12 border-t border-border pt-6 text-sm text-muted">
          <Link className="text-primary hover:underline" to="/">
            Back to CodeAudit
          </Link>
        </p>
      </div>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalShell title="Privacy" updated="20 August 2026">
      <p>
        CodeAudit scans source repositories, which means it necessarily reads code and the metadata
        around it. This page says what is collected, what leaves our infrastructure, and how long
        anything is kept. It describes the system as built; where a limit is enforced by code rather
        than by policy, that is said explicitly.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account.</strong> Your email address, and a display name if you provide one. If you
          sign in with GitHub, we also store your GitHub user ID and avatar URL.
        </li>
        <li>
          <strong>Repositories you connect.</strong> Names, owners, default branches, commit
          metadata, and the findings produced by scanning them.
        </li>
        <li>
          <strong>Activity.</strong> An audit log of actions taken in your workspace, and system
          events recording scan and queue behaviour.
        </li>
      </ul>

      <h2>Your code</h2>
      <p>
        Repositories are cloned to temporary storage on a worker, analysed, and deleted when the job
        finishes. We do not retain a copy of your source.
      </p>
      <p>
        Findings deliberately do not contain the sensitive values they describe. A detected
        credential is stored redacted — a few leading characters and a length — alongside a
        non-reversible fingerprint used only to recognise the same finding across scans. The raw
        value is never written to the database, an API response, or a pull-request comment. This is
        enforced at a single choke point in the detection engine rather than left to each caller.
      </p>

      <h2>Where data goes</h2>
      <p>Hosting and processing are in AWS, Europe (Frankfurt). We use these sub-processors:</p>
      <ul>
        <li>
          <strong>Resend</strong> — delivers sign-in emails. Receives your email address.
        </li>
        <li>
          <strong>GitHub</strong> — repository access, on the permissions you grant the GitHub App.
        </li>
        <li>
          <strong>An OpenAI-compatible LLM provider</strong> — used to judge whether unreferenced
          code is genuinely dead. Receives the specific code snippets under review, not the
          repository. This step is optional and can be left unconfigured, in which case scans run
          without it.
        </li>
        <li>
          <strong>Stripe</strong> — payment processing for paid plans. We never see or store card
          details.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <ul>
        <li>Audit log entries: 180 days, then swept automatically.</li>
        <li>System events: 30 days, then swept automatically.</li>
        <li>Account, repository and finding data: until you delete the account.</li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        Email us and we will delete your account, your organisations, and every repository, scan and
        finding attached to them. Deletion cascades in the database, so nothing is left orphaned.
      </p>

      <h2>Cookies</h2>
      <p>
        We use no advertising or analytics cookies. Your session token is held in your browser's
        local storage so that you stay signed in, and nowhere else.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, deletion requests, or anything else about this page:{" "}
        <a className="text-primary hover:underline" href="mailto:privacy@codeaudit.madhavaryal.info.np">
          privacy@codeaudit.madhavaryal.info.np
        </a>
        .
      </p>
    </LegalShell>
  );
}

export function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="20 August 2026">
      <p>
        By using CodeAudit you agree to what follows. It is deliberately short, and it tries to be
        accurate about what the product can and cannot do rather than maximally protective.
      </p>

      <h2>The service</h2>
      <p>
        CodeAudit analyses repositories you connect and reports what it finds: dependencies that do
        not exist on the registry, known vulnerabilities, credentials committed to source or
        history, unreferenced code, and unsafe or manipulated AI agent configuration.
      </p>

      <h2>What it does not promise</h2>
      <p>
        Detection is not proof of absence. Several checks are heuristics and are documented as such;
        a clean scan means nothing matched the rules, not that a repository is secure. Some
        categories are explicitly out of reach — an instruction file can be rewritten in wording no
        rule anticipates, and a scanner reading text cannot always tell intent from phrasing. Treat
        findings as evidence for a human decision, not as a verdict.
      </p>
      <p>
        You remain responsible for your code, your dependencies and your credentials. Nothing here
        transfers that.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must control the email address you sign up with.</li>
        <li>You must have the right to grant access to the repositories you connect.</li>
        <li>You are responsible for what happens under your account.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        Do not use CodeAudit to scan repositories you have no right to access, to attack the service
        or the registries it queries, or to work around plan limits by automation. Automated
        actions — scanning on push, merge gates, fix pull requests — are opt-in per repository and
        off by default; enabling one is your decision to let the service act on your code.
      </p>

      <h2>Availability and changes</h2>
      <p>
        The service is provided as-is, with no uptime guarantee. We may change or discontinue
        features. Where a change materially affects how your data is handled, we will say so on the
        privacy page and date it.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, CodeAudit is not liable for indirect or consequential loss,
        including any loss arising from a finding it reported or failed to report.
      </p>

      <h2>Ending it</h2>
      <p>
        You can stop using the service and request deletion at any time. We may suspend an account
        that breaches these terms or endangers the service.
      </p>

      <h2>Contact</h2>
      <p>
        <a className="text-primary hover:underline" href="mailto:support@codeaudit.madhavaryal.info.np">
          support@codeaudit.madhavaryal.info.np
        </a>
      </p>
    </LegalShell>
  );
}
