import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { PageInfoProvider } from "@/components/layout/theme-context";
import { AppShell } from "@/components/layout/app-shell";
import { Toaster } from "@/components/ui/sonner";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Arcana",
  description: "Your personal research engine — collect papers, extract insights, form hypotheses, and iterate.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <PageInfoProvider>
          <AppShell>{children}</AppShell>
        </PageInfoProvider>
        <Toaster />
      </body>
    </html>
  );
}
