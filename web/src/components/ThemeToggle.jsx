import { useEffect, useState } from "react";
import { applyTheme, storedTheme } from "../lib/theme.js";

/** Two-state switch between the console and paper palettes. */
export default function ThemeToggle({ className = "" }) {
  const [theme, setTheme] = useState(storedTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={`themetoggle mono ${className}`}
      onClick={() => setTheme(next)}
      aria-label={`Switch to the ${next} palette`}
      title={`Switch to the ${next} palette`}
    >
      {theme === "dark" ? "DARK" : "PAPER"}
    </button>
  );
}
