import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Average Price Tracker",
  description: "Local-first, lot-aware crypto portfolio tracker.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <Link href="/">Portfolio</Link>
          <Link href="/lots">Review lots</Link>
          <Link href="/settings">Connection &amp; settings</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
