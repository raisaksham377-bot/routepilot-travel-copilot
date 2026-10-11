import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RoutePilot — travel decision workspace',
  description:
    'A constraint-led executive travel decision workspace that shows its reasoning. Sample and manually entered data only.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
