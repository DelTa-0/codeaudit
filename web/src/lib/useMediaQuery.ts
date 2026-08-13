import { useEffect, useState } from "react";

/**
 * Media query as a boolean.
 *
 * The landing page is styled with inline `style={{}}` objects, and inline
 * styles cannot express a media query — there is no CSS rule to attach one to.
 * That is why the marketing pages had no responsive behaviour at all and
 * overflowed 179px at 375px wide. This hook is the escape hatch: components
 * keep their inline styles and pick mobile values from JS.
 *
 * The initial state is read synchronously from matchMedia rather than
 * defaulting to false, so the first paint is already correct and narrow
 * screens never flash the desktop layout before correcting.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // resync in case the query changed between render and effect

    mql.addEventListener("change", onChange);
    // Belt and braces: the MediaQueryList `change` event does not always fire
    // when the viewport is resized through devtools/CDP emulation, which left
    // the layout stale at the new width. `resize` covers that, and setMatches
    // with an unchanged boolean is a no-op for React, so the extra listener
    // costs nothing in the common case.
    window.addEventListener("resize", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, [query]);

  return matches;
}

/** Phones. Matches Tailwind's `sm` breakpoint so JS and class-based rules agree. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}

/** Phones and small tablets — for layouts that need to reflow before `sm`. */
export function useIsCompact(): boolean {
  return useMediaQuery("(max-width: 899px)");
}
