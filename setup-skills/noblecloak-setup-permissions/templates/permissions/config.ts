/**
 * What the example reads from its environment. `NEXT_PUBLIC_*` values are inlined when `next build` runs, so
 * pointing the app at a deployment is a rebuild with these variables, not a runtime switch.
 */

export type ExampleConfig = (
  | {
      /** The mock has no authorization server: the page takes the `admin` token from it. */
      readonly mode: 'mock';
      readonly apiUrl: string;
    }
  | {
      readonly mode: 'oidc';
      readonly apiUrl: string;
      readonly issuer: string;
      readonly clientId: string;
      readonly redirectUri: string;
    }
) & {
  /**
   * The roles to show as columns (`NEXT_PUBLIC_NC_ROLES`, comma-separated role keys), before the roles the
   * policies name. Neither the contract's mock nor every deployment lists roles, so the app names them.
   */
  readonly roles: readonly string[];
};
// The redirect URI is read from `NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI`, not the approvals page's variable, so
// an app with both pages sends each page's sign-in back to its own callback.

export type ConfigResult =
  | { readonly ok: true; readonly config: ExampleConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

export type ConfigSource = Readonly<Record<string, string | undefined>>;

const isAbsoluteUrl = (value: string): boolean => URL.canParse(value);

/** The API's origin as the sign-in `resource`: the origin itself, byte for byte, with no path. */
const isOrigin = (value: string): boolean => URL.canParse(value) && new URL(value).origin === value;

/** The module's rule for an issuer, a `resource` and a redirect URI: `https:`, or `http://localhost` on any port. */
const isSecure = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
};

/** Checks a source of variables (`process.env` in the app) and says what is missing or malformed. */
export function parseConfig(source: ConfigSource): ConfigResult {
  const problems: string[] = [];
  const read = (name: string): string => (source[name] ?? '').trim();

  const modeValue = read('NEXT_PUBLIC_NC_MODE');
  if (modeValue !== '' && modeValue !== 'mock' && modeValue !== 'oidc') {
    problems.push('NEXT_PUBLIC_NC_MODE is mock or oidc (or unset, which means oidc)');
  }
  const mock = modeValue === 'mock';

  const rolesText = read('NEXT_PUBLIC_NC_ROLES');
  const roles = rolesText === '' ? [] : rolesText.split(',').map((role) => role.trim());
  if (roles.some((role) => role === '' || !/^[\w.:-]+$/.test(role)))
    problems.push('NEXT_PUBLIC_NC_ROLES is a comma-separated list of role keys');

  const apiUrl = read('NEXT_PUBLIC_NC_API_URL');
  if (apiUrl === '') problems.push('NEXT_PUBLIC_NC_API_URL is not set');
  else if (!isOrigin(apiUrl))
    problems.push('NEXT_PUBLIC_NC_API_URL is an origin with no path or trailing slash');

  if (mock) {
    // The mock takes no sign-in, so its API origin (http://127.0.0.1:8787 by default) needs no scheme rule.
    return problems.length > 0
      ? { ok: false, problems }
      : { ok: true, config: { mode: 'mock', apiUrl, roles } };
  }

  // Sign-in names the API as the token's audience (`resource`): the module accepts only https or http://localhost.
  if (apiUrl !== '' && isOrigin(apiUrl) && !isSecure(apiUrl))
    problems.push('NEXT_PUBLIC_NC_API_URL uses https (or http://localhost) for sign-in');

  const issuer = read('NEXT_PUBLIC_NC_ISSUER');
  if (issuer === '') problems.push('NEXT_PUBLIC_NC_ISSUER is not set');
  else if (!isAbsoluteUrl(issuer)) problems.push('NEXT_PUBLIC_NC_ISSUER is an absolute URL');
  else if (!isSecure(issuer))
    problems.push('NEXT_PUBLIC_NC_ISSUER uses https (or http://localhost)');
  const clientId = read('NEXT_PUBLIC_NC_CLIENT_ID');
  if (clientId === '') problems.push('NEXT_PUBLIC_NC_CLIENT_ID is not set');
  const redirectUri = read('NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI');
  if (redirectUri === '') problems.push('NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is not set');
  else if (!isAbsoluteUrl(redirectUri))
    problems.push('NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is an absolute URL');
  else if (!isSecure(redirectUri))
    problems.push('NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI uses https (or http://localhost)');
  else if (/[?#*]/.test(redirectUri))
    problems.push(
      'NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI is exact: no query, fragment or wildcard'
    );

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, config: { mode: 'oidc', apiUrl, issuer, clientId, redirectUri, roles } };
}

/** The app's configuration. Each variable is named in full so that the build can inline it. */
export function readConfig(): ConfigResult {
  return parseConfig({
    NEXT_PUBLIC_NC_MODE: process.env.NEXT_PUBLIC_NC_MODE,
    NEXT_PUBLIC_NC_API_URL: process.env.NEXT_PUBLIC_NC_API_URL,
    NEXT_PUBLIC_NC_ISSUER: process.env.NEXT_PUBLIC_NC_ISSUER,
    NEXT_PUBLIC_NC_CLIENT_ID: process.env.NEXT_PUBLIC_NC_CLIENT_ID,
    NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI: process.env.NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI,
    NEXT_PUBLIC_NC_ROLES: process.env.NEXT_PUBLIC_NC_ROLES,
  });
}
