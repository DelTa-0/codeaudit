const OPT_INS = [
  { title: "Webhook auto-scan", body: "Scan automatically on every push", bg: "#12b673", bd: "#0e9b60", side: "flex-end" as const },
  { title: "Merge gate", body: "Block PRs below your score threshold", bg: "#e0ddd2", bd: "#cfccc0", side: "flex-start" as const },
  { title: "Auto-fix PRs", body: "Bot opens dependency-cleanup PRs", bg: "#e0ddd2", bd: "#cfccc0", side: "flex-start" as const },
];

export function Trust() {
  return (
    <section style={{ background: "#d9f4e3", padding: "96px 48px" }}>
      <div
        style={{
          maxWidth: 1024,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 64,
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <span
            style={{
              font: "500 12px 'JetBrains Mono',monospace",
              color: "#127a4f",
              letterSpacing: ".08em",
              marginBottom: 18,
            }}
          >
            EVERYTHING IS OPT-IN
          </span>
          <h2
            style={{
              margin: 0,
              font: "600 44px/1.1 Geist,sans-serif",
              letterSpacing: "-.02em",
              color: "#0c2a1c",
              textWrap: "balance",
            }}
          >
            We propose. You decide.
          </h2>
          <p
            style={{
              margin: "18px 0 0",
              font: "400 16.5px/1.6 Geist,sans-serif",
              color: "#12503a",
              textWrap: "pretty",
            }}
          >
            Every automation ships <strong style={{ fontWeight: 600 }}>off by default</strong> and
            requires an explicit toggle. CodeAudit never merges, blocks, or deletes anything
            without a human decision. Auto-fix PRs are opened — never auto-merged.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {OPT_INS.map((o) => (
            <div
              key={o.title}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "#f7f6f1",
                border: "1px solid #bfeacf",
                borderRadius: 12,
                padding: "16px 20px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ font: "600 15px Geist,sans-serif", color: "#101512" }}>{o.title}</span>
                <span style={{ font: "400 13px Geist,sans-serif", color: "#565b51" }}>{o.body}</span>
              </div>
              <div
                style={{
                  flex: "none",
                  width: 40,
                  height: 22,
                  borderRadius: 99,
                  background: o.bg,
                  border: `1px solid ${o.bd}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: o.side,
                  padding: "0 3px",
                  boxSizing: "border-box",
                }}
              >
                <span style={{ width: 16, height: 16, borderRadius: 99, background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.2)" }} />
              </div>
            </div>
          ))}
          <span style={{ font: "500 11.5px 'JetBrains Mono',monospace", color: "#12503a", padding: "0 4px" }}>
            DEFAULT STATE SHOWN — YOU FLIP THE SWITCHES.
          </span>
        </div>
      </div>
    </section>
  );
}
