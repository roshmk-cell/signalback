import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signalback — Find the signal. Know your next move.",
  description:
    "Catch the decisions, deadlines, and blockers buried in your conversations, with findings linked to their original messages.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
