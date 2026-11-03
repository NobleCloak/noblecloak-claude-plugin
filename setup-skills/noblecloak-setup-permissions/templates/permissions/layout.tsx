import '@noblecloak/react/styles.css';

import type { ReactNode } from 'react';

export default function PermissionsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <main>{children}</main>;
}
