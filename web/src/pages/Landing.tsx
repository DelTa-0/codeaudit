import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Nav } from "../components/landing/Nav";
import { Hero, ThreatMarquee } from "../components/landing/Hero";
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
import "../components/landing/landing.css";

/**
 * Reveal-on-scroll: every [data-reveal] element fades in as it enters the
 * viewport. A plain scroll-position check rather than IntersectionObserver —
 * IO callbacks stall in non-compositing contexts (hidden panes, prerender),
 * which would leave the whole page invisible.
 */
function useScrollReveal() {
  useEffect(() => {
    const pending = new Set(document.querySelectorAll(".ca [data-reveal]"));
    const check = () => {
      // At the very bottom of the page, elements in the last few percent of
      // the viewport can never cross the threshold — reveal everything left.
      const atBottom =
        window.scrollY + window.innerHeight >= document.body.scrollHeight - 8;
      const limit = window.innerHeight * (atBottom ? 1.01 : 0.95);
      for (const el of pending) {
        if (el.getBoundingClientRect().top < limit) {
          el.classList.add("is-in");
          pending.delete(el);
        }
      }
      if (pending.size === 0) window.removeEventListener("scroll", check);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);
}

export function Landing() {
  const { user, loading } = useAuth();
  useScrollReveal();
  if (!loading && user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="ca">
      <div className="ca-grain" aria-hidden="true" />
      <Nav />
      <Hero />
      <ThreatMarquee />
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
