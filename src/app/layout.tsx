import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { LayoutThemeProvider } from "@/components/layout/theme-context";
import { LayoutSwitcher } from "@/components/layout/layout-switcher";
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
  description: "Research paper repository with AI-powered analysis",
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
      >
        <LayoutThemeProvider>
          <LayoutSwitcher>{children}</LayoutSwitcher>
        </LayoutThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
