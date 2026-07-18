import { useEffect, useRef, useState } from "react";

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

export const SCAN_LINES: DemoLine[] = [
  { t: "$ npx codeaudit scan .", c: "#e8ede8" },
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

const TARGET_SCORE = 82;
const WORD_INTERVAL_MS = 2400;
const LINE_INTERVAL_MS = 650;
const TICK_MS = 50;

/** Ports the design's DCLogic ticker: rotating hero word, terminal log reveal, score count-up. */
export function useScanDemo() {
  const [wordIndex, setWordIndex] = useState(0);
  const [step, setStep] = useState(1);
  const [score, setScore] = useState(0);
  const wordAcc = useRef(0);
  const lineAcc = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      wordAcc.current += TICK_MS;
      lineAcc.current += TICK_MS;

      if (wordAcc.current >= WORD_INTERVAL_MS) {
        wordAcc.current = 0;
        setWordIndex((i) => (i + 1) % ROTATING_WORDS.length);
      }

      if (lineAcc.current >= LINE_INTERVAL_MS) {
        lineAcc.current = 0;
        setStep((s) => {
          const next = s >= SCAN_LINES.length + 5 ? 1 : s + 1;
          if (next === 1) setScore(0);
          return next;
        });
      }

      setStep((s) => {
        if (s >= SCAN_LINES.length) {
          setScore((sc) => Math.min(TARGET_SCORE, sc + 3));
        }
        return s;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return {
    word: ROTATING_WORDS[wordIndex],
    visibleLines: SCAN_LINES.slice(0, Math.min(step, SCAN_LINES.length)),
    score,
  };
}

const COPY_COMMAND = "npx codeaudit scan .";

export function useCopyCommand() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(COPY_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { copied, copy };
}
