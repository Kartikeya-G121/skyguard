import { useEffect, useRef } from "react";

/**
 * The sky behind the cover. Its colour comes from the station's local solar
 * hour and its drift speed from the observed humidity — if the reading moves,
 * the sky moves with it. It carries no information the page states elsewhere,
 * so it stays extremely quiet.
 */
export default function SkyBackdrop({ hour = 12, humidity = 50, temp = 25 }) {
  const ref = useRef(null);
  const state = useRef({ hour, humidity, temp, t: 0 });
  state.current.hour = hour;
  state.current.humidity = humidity;
  state.current.temp = temp;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = canvas.getContext("2d");
    let raf = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    // Horizontal bands of haze. Thicker and slower when the air is humid.
    const bands = Array.from({ length: 7 }, (_, i) => ({
      y: 0.12 + i * 0.12,
      speed: 0.00004 + i * 0.000022,
      phase: i * 1.7,
    }));

    const draw = (now) => {
      const { hour: h, humidity: rh } = state.current;
      const w = canvas.width;
      const ht = canvas.height;
      ctx.clearRect(0, 0, w, ht);

      // Night → dawn → day → dusk, as a single warm-cool sweep. On paper the
      // same sweep runs the other way: the sky lightens towards the horizon
      // instead of darkening, so the trace still reads as ink on a page.
      const daylight = Math.max(0, Math.cos(((h - 14) / 24) * 2 * Math.PI));
      const paper = document.documentElement.dataset.theme === "light";
      const grad = ctx.createLinearGradient(0, 0, 0, ht);
      if (paper) {
        grad.addColorStop(0, `rgba(243,239,230,1)`);
        grad.addColorStop(0.55, `rgba(${238 - daylight * 4}, ${233 - daylight * 6}, ${221 - daylight * 8}, 1)`);
        grad.addColorStop(1, `rgba(${232 - daylight * 12}, ${225 - daylight * 14}, ${210 - daylight * 6}, 1)`);
      } else {
        grad.addColorStop(0, `rgba(22,27,36,1)`);
        grad.addColorStop(0.55, `rgba(${30 + daylight * 18}, ${37 + daylight * 18}, ${50 + daylight * 14}, 1)`);
        grad.addColorStop(1, `rgba(${38 + daylight * 66}, ${44 + daylight * 36}, ${56 + daylight * 14}, 1)`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, ht);

      const haze = paper ? "27,33,42" : "236,231,220";
      const opacity = 0.018 + (rh / 100) * 0.05;
      for (const b of bands) {
        const drift = reduce ? 0 : Math.sin(now * b.speed + b.phase);
        const y = b.y * ht + drift * ht * 0.02;
        const g2 = ctx.createLinearGradient(0, y - ht * 0.05, 0, y + ht * 0.05);
        g2.addColorStop(0, `rgba(${haze},0)`);
        g2.addColorStop(0.5, `rgba(${haze},${opacity})`);
        g2.addColorStop(1, `rgba(${haze},0)`);
        ctx.fillStyle = g2;
        ctx.fillRect(0, y - ht * 0.05, w, ht * 0.1);
      }

      if (!reduce) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="sky" aria-hidden="true" />;
}
