export function Problem() {
  return (
    <section
      style={{
        borderTop: "1px solid #e6e4dc",
        padding: "96px 48px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 64,
        alignItems: "center",
        maxWidth: 1120,
        margin: "0 auto",
        boxSizing: "border-box",
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
          THE PROBLEM
        </span>
        <h2
          style={{
            margin: 0,
            font: "600 40px/1.12 Geist,sans-serif",
            letterSpacing: "-.02em",
            textWrap: "balance",
          }}
        >
          Your AI just imported a package that doesn't exist.
        </h2>
        <p
          style={{
            margin: "18px 0 0",
            font: "400 16.5px/1.6 Geist,sans-serif",
            color: "#565b51",
            textWrap: "pretty",
          }}
        >
          LLMs invent plausible-sounding package names — a 2026 multi-LLM study across 576k
          samples found{" "}
          <strong style={{ fontWeight: 600, color: "#101512" }}>
            ~20% of AI-recommended packages are hallucinated
          </strong>
          . Attackers register those exact names before you notice. It's called slopsquatting,
          and it's happening now.
        </p>
        <p
          style={{
            margin: "14px 0 0",
            font: "400 16.5px/1.6 Geist,sans-serif",
            color: "#565b51",
            textWrap: "pretty",
          }}
        >
          CodeAudit verifies every dependency against the live npm registry, on every push.
        </p>
      </div>
      <div style={{ background: "#fff", border: "1px solid #e6e4dc", borderRadius: 12, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderBottom: "1px solid #efede6",
            font: "500 11.5px 'JetBrains Mono',monospace",
            color: "#8d9187",
          }}
        >
          <span>src/utils/pricing.ts</span>
          <span>PR #241</span>
        </div>
        <div style={{ padding: "14px 0", font: "400 13px/1.9 'JetBrains Mono',monospace" }}>
          <div style={{ padding: "0 16px", color: "#8d9187" }}>  import {"{"} round {"}"} from 'lodash'</div>
          <div style={{ padding: "0 16px", background: "#fdeae5", color: "#8c2f1b" }}>
            + import {"{"} formatMoney {"}"} from 'currency-format-pro'
          </div>
          <div style={{ padding: "0 16px", color: "#8d9187" }}>  export function lineTotal(qty, price) {"{"}</div>
          <div style={{ padding: "0 16px", color: "#8d9187" }}>    return formatMoney(round(qty * price, 2))</div>
          <div style={{ padding: "0 16px", color: "#8d9187" }}>  {"}"}</div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            margin: "0 16px 16px",
            padding: "12px 14px",
            background: "#fdeae5",
            border: "1px solid #f5cabb",
            borderRadius: 8,
          }}
        >
          <span
            style={{
              font: "600 11px 'JetBrains Mono',monospace",
              color: "#fff",
              background: "#c2452d",
              padding: "2px 7px",
              borderRadius: 99,
              whiteSpace: "nowrap",
            }}
          >
            PHANTOM
          </span>
          <span style={{ font: "400 12.5px/1.5 'JetBrains Mono',monospace", color: "#8c2f1b" }}>
            currency-format-pro is not on npm. This exact name is a known slopsquatting target.
          </span>
        </div>
      </div>
    </section>
  );
}
