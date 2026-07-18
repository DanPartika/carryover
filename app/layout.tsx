import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { AccountControl, AuthContextProvider } from "@/components/AuthContext";
import { RequireAuth } from "@/components/RequireAuth";
import { withBase } from "@/lib/config/basePath";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Carryover — your PT's plan, always with you",
  description:
    "The loop between PT visits: your physical therapist builds your program, you see exactly what to do at home, and your progress flows back before the next visit.",
  icons: { icon: withBase("/icon.svg") },
};

export const viewport: Viewport = {
  themeColor: "#f7f6f2",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <AuthContextProvider>
          <header className="border-b border-edge bg-card">
            <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
              <Link href="/" className="text-lg font-extrabold tracking-tight">
                <span aria-hidden>↪ </span>
                <span className="brand-text">Carryover</span>
              </Link>
              <nav className="flex items-center gap-4">
                <Link
                  href="/library"
                  className="text-sm font-semibold text-muted transition hover:text-ink"
                >
                  Library
                </Link>
                <AccountControl />
              </nav>
            </div>
          </header>
          <RequireAuth>
            <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
          </RequireAuth>
        </AuthContextProvider>
      </body>
    </html>
  );
}
