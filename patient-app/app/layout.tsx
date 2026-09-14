import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import ThemeRegistry from "./ThemeRegistry";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Pulse Window — Medication and Pulse Companion";
  const description = "Keep medicines, dose times, symptoms, cuff readings, and camera pulse estimates together.";

  return {
    title,
    description,
    manifest: "/manifest.webmanifest",
    icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
    appleWebApp: { capable: true, statusBarStyle: "default", title: "Pulse Window" },
    openGraph: { title, description, images: [`${origin}/og.png`] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f3f6f2",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ThemeRegistry>{children}</ThemeRegistry>
      </body>
    </html>
  );
}
