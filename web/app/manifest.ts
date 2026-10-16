import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Secure Workspace',
    short_name: 'Workspace',
    description: 'Role-based secure record workspace',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f3fa',
    theme_color: '#6754d9',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
