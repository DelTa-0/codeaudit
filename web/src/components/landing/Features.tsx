const FEATURES = [
  {
    tag: "REGISTRY-VERIFIED",
    tagFg: "#c2452d",
    tagBg: "#fdeae5",
    title: "Phantom dependency detection",
    body: "Every import checked against the live npm registry. Hallucinated packages flagged before an attacker can slopsquat them.",
  },
  {
    tag: "AI-REVIEWED",
    tagFg: "#b07d1e",
    tagBg: "#fdf3dd",
    title: "Zombie & dead-code detection",
    body: "Static analysis finds unreferenced code; an LLM pass assigns a confidence score so you only see credible candidates.",
  },
  {
    tag: "GITHUB CHECK",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "Merge gate",
    body: "A GitHub check that can block PRs below your score threshold. Off by default — you set the bar.",
  },
  {
    tag: "NEVER AUTO-MERGED",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "Auto-fix PRs",
    body: "The bot opens PRs that remove unused dependencies. You review and merge — it never merges itself.",
  },
  {
    tag: "METRICS",
    tagFg: "#565b51",
    tagBg: "#efede6",
    title: "AI-authorship metrics",
    body: "Debt density split by AI-touched vs human-written code — hard data for justifying your AI tooling.",
  },
  {
    tag: "BADGE",
    tagFg: "#565b51",
    tagBg: "#efede6",
    title: "README score badge",
    body: "A live health-score badge for your README. Green looks good on you.",
  },
];

export function Features() {
  return (
    <section id="features" style={{ borderTop: "1px solid #e6e4dc", padding: "96px 48px" }}>
      <div style={{ maxWidth: 1024, margin: "0 auto" }}>
        <span style={{ font: "500 12px 'JetBrains Mono',monospace", color: "#127a4f", letterSpacing: ".08em" }}>
          FEATURES
        </span>
        <h2
          style={{
            margin: "16px 0 0",
            font: "600 40px/1.12 Geist,sans-serif",
            letterSpacing: "-.02em",
            maxWidth: 520,
            textWrap: "balance",
          }}
        >
          Six things it does today. Not a roadmap.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20, marginTop: 44 }}>
          {FEATURES.map((f) => (
            <div
              key={f.title}
              style={{
                background: "#fff",
                border: "1px solid #e6e4dc",
                borderRadius: 12,
                padding: 24,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <span
                style={{
                  font: "600 12px 'JetBrains Mono',monospace",
                  color: f.tagFg,
                  background: f.tagBg,
                  padding: "4px 10px",
                  borderRadius: 99,
                  width: "fit-content",
                }}
              >
                {f.tag}
              </span>
              <span style={{ font: "600 17px Geist,sans-serif" }}>{f.title}</span>
              <span style={{ font: "400 14px/1.55 Geist,sans-serif", color: "#565b51" }}>{f.body}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
