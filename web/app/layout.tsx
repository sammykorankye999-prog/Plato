import type { Metadata } from 'next';
import './style.css';

export const metadata: Metadata = {
  title: 'Local Login | Secure Workspace',
  description: 'Role-based input workspace',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Browser extensions and accessibility tools may add attributes to <html>
  // before React hydrates. Suppress only this root-element mismatch.
  return <html lang="en" suppressHydrationWarning><body>{children}</body></html>;
}
