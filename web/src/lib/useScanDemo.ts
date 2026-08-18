import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./useFx";

export const ROTATING_WORDS = [
  "hallucinated packages",
  "dead code",
  "unused dependencies",
  "AI tech debt",
];

export interface DemoLine {
  t: string;
  c: string;
}

// Colors sit on the dark ink certificate card — the production terminal
// scheme: mint for pass, amber for warn, coral for critical.
export const SCAN_LINES: DemoLine[] = [
  { t: "$ npx codeorion scan .", c: "#e8ede8" },
  { t: "→ cloning acme/checkout-service … done (1.2s)", c: "#8a948b" },
  { t: "→ parsing 214 files · 142 dependencies", c: "#8a948b" },
  { t: "→ checking npm registry (live) …", c: "#8a948b" },
  { t: "✗ phantom: currency-format-pro — not on npm", c: "#ff8a70" },
  { t: "✗ phantom: react-hooks-utils2 — not on npm", c: "#ff8a70" },
  { t: "! zombie: src/legacy/parse.ts — unused (0.94 conf)", c: "#f0c064" },
  { t: "→ LLM review: 3 findings confirmed", c: "#8a948b" },
  { t: "✓ scan complete — 12 findings, 2 critical", c: "#9ef0c6" },
  { t: "HEALTH SCORE 82/100  ▲ +6 vs last scan", c: "#9ef0c6" },
];

const TOTAL_CHARS = SCAN_LINES.reduce((n, l) => n + l.t.length, 0);
const TARGET_SCORE = 82;
const WORD_INTERVAL_MS = 2600;
const TICK_MS = 36;
const CHARS_PER_TICK = 3;
const HOLD_TICKS = 96; // ~3.5s pause on the stamped certificate before looping

/** Slice the scan record to the first `chars` characters, split across lines. */
function linesAt(chars: number): DemoLine[] {
  const out: DemoLine[] = [];
  let remaining = chars;
  for (const line of SCAN_LINES) {
    if (remaining <= 0) break;
    if (remaining >= line.t.length) {
      out.push(line);
      remaining -= line.t.length;
    } else {
      out.push({ t: line.t.slice(0, remaining), c: line.c });
      remaining = 0;
    }
  }
  return out;
}

/** Rotating hero word + char-by-char terminal typing + score count-up, on one ticker. */
export function useScanDemo() {
  const [wordIndex, setWordIndex] = useState(0);
  const [chars, setChars] = useState(0);
  const [score, setScore] = useState(0);
  const st = useRef({ chars: 0, score: 0, hold: 0, wordAcc: 0 });

  useEffect(() => {
    if (prefersReducedMotion()) {
      setChars(TOTAL_CHARS);
      setScore(TARGET_SCORE);
      return;
    }
    const id = setInterval(() => {
      const s = st.current;
      s.wordAcc += TICK_MS;
      if (s.wordAcc >= WORD_INTERVAL_MS) {
        s.wordAcc = 0;
        setWordIndex((i) => (i + 1) % ROTATING_WORDS.length);
      }
      if (s.chars < TOTAL_CHARS) {
        s.chars = Math.min(TOTAL_CHARS, s.chars + CHARS_PER_TICK);
      } else if (s.score < TARGET_SCORE) {
        s.score = Math.min(TARGET_SCORE, s.score + 3);
      } else if (s.hold < HOLD_TICKS) {
        s.hold += 1;
      } else {
        s.chars = 0;
        s.score = 0;
        s.hold = 0;
      }
      setChars(s.chars);
      setScore(s.score);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  return {
    word: ROTATING_WORDS[wordIndex],
    visibleLines: linesAt(chars),
    typing: chars < TOTAL_CHARS,
    score,
    /** True once the count-up lands — cues the verdict stamp. */
    stamped: score >= TARGET_SCORE,
  };
}

const COPY_COMMAND = "npx codeorion scan .";

export function useCopyCommand() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(COPY_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { copied, copy };
}
