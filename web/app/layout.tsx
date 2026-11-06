import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "HELD — Your place is held",
  description:
    "Reserve a spot with a USDC deposit. Show up or cancel by the deadline for a refund. Miss the event and the organizer keeps the deposit, unless they refund you.",
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
