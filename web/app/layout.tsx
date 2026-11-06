import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "HELD — Your place is reserved",
  description:
    "A fair, transparent commitment layer for events. Show up and your refundable deposit comes back.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="min-h-full">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
