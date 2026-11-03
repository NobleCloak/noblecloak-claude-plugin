'use client';

import { Approvals, useApprovals } from '@noblecloak/react/approvals';
import { AuthError, useAuthState } from '@noblecloak/react/auth';
import type { BrowserAuth } from '@noblecloak/react/auth';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { construct, logFault } from './auth';
import type { ExampleConfig } from './config';
import { ConfigProblem } from './ConfigProblem';

type Fetch = typeof globalThis.fetch;

export interface ApprovalsExampleProps {
  readonly config: ExampleConfig;
  /** Replaces the page's sign-in object (tests). */
  readonly auth?: BrowserAuth;
  /** Replaces `fetch` for the mock's token and the module's calls (tests). */
  readonly fetch?: Fetch;
}

const noopSubscribe = (): (() => void) => () => undefined;

/** False while the server renders and during hydration, true after: the queue shows ages from the clock. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

function Inbox({
  baseUrl,
  getToken,
  enabled,
  onSignIn,
  fetch,
}: {
  readonly baseUrl: string;
  readonly getToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  readonly enabled: boolean;
  readonly onSignIn?: () => void;
  readonly fetch?: Fetch;
}) {
  const controller = useApprovals({
    baseUrl,
    getToken,
    enabled,
    onFault: logFault,
    ...(fetch === undefined ? {} : { fetch }),
  });
  const mounted = useMounted();
  if (!mounted) return <p>Loading approvals.</p>;
  return <Approvals controller={controller} {...(onSignIn === undefined ? {} : { onSignIn })} />;
}

/** The approver's token from the mock; a missing or empty one is named, not passed on as `undefined`. */
export async function fetchMockApproverToken(apiUrl: string, fetch?: Fetch): Promise<string> {
  const response = await (fetch ?? globalThis.fetch)(`${apiUrl}/__mock/tokens`);
  if (!response.ok) throw new AuthError('server_error', 'the mock did not give a token');
  const body = (await response.json().catch(() => undefined)) as { approver?: unknown } | undefined;
  if (typeof body?.approver !== 'string' || body.approver === '')
    throw new AuthError('server_error', 'the mock gave no approver token');
  return body.approver;
}

/** Mock mode: the mock has no authorization server, so the page asks it for the approver's token. */
function MockInbox({ apiUrl, fetch }: { readonly apiUrl: string; readonly fetch?: Fetch }) {
  const getToken = useCallback(() => fetchMockApproverToken(apiUrl, fetch), [apiUrl, fetch]);
  return (
    <>
      <p role="note" data-testid="mock-banner">
        Mock token: this page is using the approver token of the mock at {apiUrl}. Nobody has signed
        in.
      </p>
      <Inbox
        baseUrl={apiUrl}
        getToken={getToken}
        enabled
        {...(fetch === undefined ? {} : { fetch })}
      />
    </>
  );
}

function SignInPanel({
  state,
  onSignIn,
}: {
  readonly state: ReturnType<BrowserAuth['getSnapshot']>;
  readonly onSignIn: () => void;
}) {
  switch (state.status) {
    case 'redirecting':
    case 'completing':
      return <p role="status">Signing in.</p>;
    case 'denied':
      return (
        <div role="alert">
          <p>Access was not granted. You can try again.</p>
          <button type="button" onClick={onSignIn}>
            Try again
          </button>
        </div>
      );
    case 'error':
      return (
        <div role="alert">
          <p>Sign-in failed: {state.error.message}</p>
          <button type="button" onClick={onSignIn}>
            Try again
          </button>
        </div>
      );
    default:
      return (
        <div>
          {state.status === 'signed_out' && state.message !== undefined && (
            <p role="status">{state.message}</p>
          )}
          <p>Sign in to see the requests waiting for you.</p>
          <button type="button" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      );
  }
}

/** Real sign-in. Nothing here calls `signIn()` except a click: not on mount, and not after a denial. */
function SignedInbox({
  config,
  auth: given,
  fetch,
}: {
  readonly config: Extract<ExampleConfig, { mode: 'oidc' }>;
  readonly auth?: BrowserAuth;
  readonly fetch?: Fetch;
}) {
  const [created] = useState(() => construct(given, config, logFault));
  if (created.problem !== undefined) return <ConfigProblem problems={[created.problem]} />;
  return (
    <SignedInboxBody
      config={config}
      auth={created.auth}
      {...(fetch === undefined ? {} : { fetch })}
    />
  );
}

function SignedInboxBody({
  config,
  auth,
  fetch,
}: {
  readonly config: Extract<ExampleConfig, { mode: 'oidc' }>;
  readonly auth: BrowserAuth;
  readonly fetch?: Fetch;
}) {
  const state = useAuthState(auth);
  useEffect(() => {
    // One refresh from a stored token, without a redirect; a no-op when nothing is stored.
    void auth.restore();
  }, [auth]);
  const getToken = useCallback(
    (options?: { forceRefresh?: boolean }) => auth.getToken(options),
    [auth]
  );
  const signIn = useCallback(() => {
    void auth.signIn('/approvals');
  }, [auth]);
  return state.status === 'signed_in' ? (
    <Inbox
      baseUrl={config.apiUrl}
      getToken={getToken}
      enabled
      onSignIn={signIn}
      {...(fetch === undefined ? {} : { fetch })}
    />
  ) : (
    <SignInPanel state={state} onSignIn={signIn} />
  );
}

/** The approvals page's client side: the mock's token, or a real sign-in, then the queue. */
export function ApprovalsExample({ config, auth, fetch }: ApprovalsExampleProps) {
  return config.mode === 'mock' ? (
    <MockInbox apiUrl={config.apiUrl} {...(fetch === undefined ? {} : { fetch })} />
  ) : (
    <SignedInbox
      config={config}
      {...(auth === undefined ? {} : { auth })}
      {...(fetch === undefined ? {} : { fetch })}
    />
  );
}
