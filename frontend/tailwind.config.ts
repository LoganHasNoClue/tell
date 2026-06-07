import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#06070A",
          800: "#0A0B0E",
          700: "#0E1014",
          600: "#13161B",
          500: "#1A1E25",
          400: "#262B33",
        },
        tell: {
          DEFAULT: "#00E08A",
          glow: "#33ffae",
          dim: "#0c6b48",
        },
        market: "#8A8F98",
        up: "#2BD98A",
        down: "#FF4D5E",
        muted: "#6B7280",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        tell: "0 0 24px rgba(0, 224, 138, 0.35)",
        "tell-lg": "0 0 60px rgba(0, 224, 138, 0.25)",
        flag: "0 0 40px rgba(0, 224, 138, 0.45)",
        "flag-red": "0 0 40px rgba(255, 77, 94, 0.40)",
      },
      keyframes: {
        flashIn: {
          "0%": { backgroundColor: "rgba(0,224,138,0.22)" },
          "100%": { backgroundColor: "rgba(0,224,138,0)" },
        },
        pulse2: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        flashIn: "flashIn 0.7s ease-out",
        pulse2: "pulse2 1.6s ease-in-out infinite",
        sweep: "sweep 2.5s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
