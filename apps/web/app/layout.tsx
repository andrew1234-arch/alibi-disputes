import type { ReactNode } from "react";

export const metadata = {
  title: "Alibi",
  description: "Every legitimate sale deserves an alibi.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
