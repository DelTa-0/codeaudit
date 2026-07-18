import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Nav } from "../components/landing/Nav";
import { Hero } from "../components/landing/Hero";
import { HeroScanDemo } from "../components/landing/HeroScanDemo";
import { Problem } from "../components/landing/Problem";
import { HowItWorks } from "../components/landing/HowItWorks";
import { Features } from "../components/landing/Features";
import { Cli } from "../components/landing/Cli";
import { PrExample } from "../components/landing/PrExample";
import { DashboardPreview } from "../components/landing/DashboardPreview";
import { Trust } from "../components/landing/Trust";
import { Pricing } from "../components/landing/Pricing";
import { FinalCta } from "../components/landing/FinalCta";
import { Footer } from "../components/landing/Footer";

// Landing-only keyframes (the design's pulse/blink animations) — scoped via
// a style tag rather than global CSS since this page's brand is intentionally
// isolated from the dashboard's dark theme (styles.css).
const KEYFRAMES = `
@keyframes cd-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
@keyframes cd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
`;

export function Landing() {
  const { user, loading } = useAuth();
  if (!loading && user) return <Navigate to="/dashboard" replace />;

  return (
    <div style={{ background: "#f7f6f1", fontFamily: "Geist, system-ui, sans-serif", color: "#101512" }}>
      <style>{KEYFRAMES}</style>
      <Nav />
      <Hero />
      <HeroScanDemo />
      <Problem />
      <HowItWorks />
      <Features />
      <Cli />
      <PrExample />
      <DashboardPreview />
      <Trust />
      <Pricing />
      <FinalCta />
      <Footer />
    </div>
  );
}
