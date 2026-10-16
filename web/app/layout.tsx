import type { Metadata } from 'next';
import './style.css';
import { ServiceWorkerRegistration } from './service-worker';

export const metadata: Metadata = {
  title: 'Secure Workspace',
  description: 'Role-based input workspace',
  applicationName: 'Secure Workspace',
  appleWebApp: { capable: true, title: 'Secure Workspace', statusBarStyle: 'default' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Browser extensions and accessibility tools may add attributes to <html>
  // before React hydrates. Suppress only this root-element mismatch.
  return <html lang="en" suppressHydrationWarning><body>{children}<ServiceWorkerRegistration /></body></html>;
}
