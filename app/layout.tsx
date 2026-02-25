import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VideoTranscoder",
  description: "Video transcoding with multi-quality output",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        style={{ background: "#0f0f1a", margin: 0 }}
      >
        <nav style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          height: 56,
          background: "#0f0f1a",
          borderBottom: "1px solid #27272a",
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          gap: 32,
        }}>
          <span style={{ color: "#667eea", fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>
            VideoTranscoder
          </span>
          <Link href="/" style={{ color: "#a1a1aa", textDecoration: "none", fontSize: 14, fontWeight: 500 }}>
            Upload
          </Link>
          <Link href="/library" style={{ color: "#a1a1aa", textDecoration: "none", fontSize: 14, fontWeight: 500 }}>
            Library
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
