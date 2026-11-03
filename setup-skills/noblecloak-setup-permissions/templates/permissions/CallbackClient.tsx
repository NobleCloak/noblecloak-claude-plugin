'use client';

import { useAuthState } from '@noblecloak/react/auth';
import type { BrowserAuth } from '@noblecloak/react/auth';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { ExampleConfig } from './config';
import { construct, logFault } from './auth';
import { ConfigProblem } from './ConfigProblem';

export interface CallbackClientProps {
  readonly config: Extract<ExampleConfig, { mode: 'oidc' }>;
  /** Replaces the page's sign-in object (tests). */
  readonly auth?: BrowserAuth;
}

/**
 * The redirect target of the authorization request. It completes the sign-in once (the module takes the
 * code out of the address first) and goes on to the permissions page only when that worked. A denial or a
 * failure stays here and says so; nothing on this page signs anyone in.
 */
export function CallbackClient({ config, auth: given }: CallbackClientProps) {
  const [created] = useState(() => construct(given, config, logFault));
  if (created.problem !== undefined) return <ConfigProblem problems={[created.problem]} />;
  return <Completing auth={created.auth} />;
}

function Completing({ auth }: { readonly auth: BrowserAuth }) {
  const state = useAuthState(auth);
  const router = useRouter();
  useEffect(() => {
    void auth.completeSignIn();
  }, [auth]);
  const returnTo = state.status === 'signed_in' ? (state.returnTo ?? '/permissions') : undefined;
  useEffect(() => {
    if (returnTo !== undefined) router.replace(returnTo);
  }, [returnTo, router]);

  if (state.status === 'denied') {
    return (
      <p role="alert">
        Access was not granted. <Link href="/permissions">Back to permissions</Link> to try again.
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <p role="alert">
        Sign-in failed: {state.error.message} <Link href="/permissions">Back to permissions</Link>{' '}
        to try again.
      </p>
    );
  }
  return <p role="status">Signing in.</p>;
}
