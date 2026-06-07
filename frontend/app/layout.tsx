import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TELL — Live fact-check",
  description:
    "Real-time fact-checking for live events. Continuously transcribes, retrieves ground-truth facts via Moss, and flags false or misleading claims as they're spoken.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
