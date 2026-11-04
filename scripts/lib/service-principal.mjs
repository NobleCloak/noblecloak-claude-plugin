/**
 * `setup.mjs service-principal`: creates the agent's own service principal with the published @noblecloak/cli, filling
 * in the deployment values (authorization server, admin API audience, govern audience) so the builder does not have to.
 *
 * The CLI signs the administrator in itself (its own PKCE loopback flow), generates the key pair locally, and writes the
 * credential file (mode 0600). This module never reads that file and never prints key material: it prints only the
 * fields of the CLI's `--json` result it names (`sp_id`, `path`).
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { discoverAuthServer, governResourceIndicator, loadAuthState, tokenIdentity } from './governance.mjs';

/** The exact CLI release this plugin drives; the flags below are the ones this version documents. */
export const CLI_PACKAGE = '@noblecloak/cli';
export const CLI_VERSION = '0.1.2';

/** The admin API audience by authorization-server issuer. The server does not advertise it (CLI README), so it is carried here. */
export const ADMIN_AUDIENCE_BY_AUTH_ISSUER = new Map([['https://auth.noblecloak.com', 'https://admin-api.noblecloak.com']]);

export class ServicePrincipalError extends Error {
  constructor(message, exit = 1) {
    super(message);
    this.exit = exit;
  }
}

const trim = (v) => String(v ?? '').trim();
const stripSlash = (s) => s.replace(/\/+$/, '');

/** "My App agent" -> "my-app-agent"; never empty. */
export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

/** The admin API audience for the deployment whose authorization server issuer is `authIssuer`; the env override wins. */
export function adminAudience(authIssuer, env = process.env) {
  const override = trim(env.NOBLECLOAK_ADMIN_AUDIENCE);
  if (override) return override;
  const known = ADMIN_AUDIENCE_BY_AUTH_ISSUER.get(stripSlash(authIssuer));
  if (known) return known;
  throw new ServicePrincipalError(
    `The admin API audience of ${authIssuer} is not known to this plugin (the server does not advertise it). Set NOBLECLOAK_ADMIN_AUDIENCE to it, ask the deployment's operator for the value.`,
    2
  );
}

/** True when `path` (which may not exist yet) lies inside a git work tree: a `.git` entry in its nearest existing directory or above. */
export function insideGitWorkTree(path) {
  let dir = dirname(resolve(path));
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  dir = realpathSync(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * The org-admin check the session's claims allow. The access token's `organizations` claim ([{ id, role }], the shape the
 * core API reads) is advisory: when it lists the org with a role other than admin, refuse; when it is absent or does not
 * list the org there is nothing to contradict and the deployment decides (the CLI exits 4 when it refuses).
 */
export function adminClaimVerdict(auth, orgId) {
  const claims = decodeClaims(auth?.accessToken);
  if (!Array.isArray(claims?.organizations)) return 'unknown';
  const entry = claims.organizations.find((o) => o && typeof o === 'object' && o.id === orgId);
  if (!entry) return 'unknown';
  return entry.role === 'admin' ? 'admin' : 'not-admin';
}

function decodeClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/** Resolves every input and refuses on the first problem. Returns the values the CLI is invoked with. Touches no network except AS discovery. */
export async function resolveServicePrincipalInputs({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  discover = discoverAuthServer,
}) {
  const auth = loadAuthState(env);
  if (!auth) throw new ServicePrincipalError('Not signed in: run /noblecloak-login first.', 3);
  const orgId = tokenIdentity(auth)?.orgId;
  if (!orgId) {
    throw new ServicePrincipalError('The signed-in session carries no organization id. Run /noblecloak-login again, choosing the organization you administer.', 1);
  }
  if (adminClaimVerdict(auth, orgId) === 'not-admin') {
    throw new ServicePrincipalError(`Your session says you are not an administrator of organization ${orgId}. Only an administrator can create a service principal; ask one to run this.`, 4);
  }

  const name = trim(flags.name) || `${basename(resolve(cwd))} agent`;
  if (name.length > 255) throw new ServicePrincipalError('--name must be 1 to 255 characters.', 2);

  let expiresInDays;
  if (flags['expires-in-days'] !== undefined) {
    expiresInDays = Number(flags['expires-in-days']);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw new ServicePrincipalError('--expires-in-days must be a whole number from 1 to 365.', 2);
    }
  }

  const out = flags.out ? resolve(cwd, flags.out) : join(home, '.noblecloak', orgId, `${slugify(name)}.json`);
  if (existsSyncAny(out)) throw new ServicePrincipalError(`${out} already exists; this command never overwrites a credential. Pass a different --out.`, 2);
  if (insideGitWorkTree(out)) {
    throw new ServicePrincipalError(`${out} is inside a git work tree, where the credential could be committed. Pass an --out outside any repository.`, 2);
  }

  const governAudience = governResourceIndicator(env);
  if (!governAudience) throw new ServicePrincipalError('Cannot determine the govern API origin: set NOBLECLOAK_GOVERN_URL.', 1);

  let authUrl;
  try {
    authUrl = stripSlash(trim((await discover(env)).issuer));
  } catch (err) {
    throw new ServicePrincipalError(`Could not read the authorization server's metadata: ${err.message}`, 1);
  }
  if (!authUrl) throw new ServicePrincipalError("The authorization server's metadata has no issuer.", 1);

  return { orgId, name, expiresInDays, out, authUrl, governAudience, adminAudience: adminAudience(authUrl, env), defaultOut: !flags.out };
}

// lstat so a dangling symlink at the path counts as existing.
function existsSyncAny(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The exact argv for `npx`. The deployment values go as flags, so no ambient NOBLECLOAK_* variable can change what the CLI targets. */
export function buildCliArgs(inputs) {
  return [
    '-y',
    `${CLI_PACKAGE}@${CLI_VERSION}`,
    'sp',
    'create',
    '--org',
    inputs.orgId,
    '--name',
    inputs.name,
    '--audience',
    inputs.governAudience,
    '--out',
    inputs.out,
    '--auth-url',
    inputs.authUrl,
    '--admin-audience',
    inputs.adminAudience,
    ...(inputs.expiresInDays !== undefined ? ['--expires-in-days', String(inputs.expiresInDays)] : []),
    '--json',
  ];
}

/**
 * Runs npx with stdin and stdout of the CLI under our control: stderr (the sign-in URL and the diagnostics) is shown live
 * and also kept, so a failure can be mapped. Resolves { status, stdout, stderr, error }.
 */
export function runCli(args, { env = process.env, stderrSink = process.stderr } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('npx', args, { env, stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => {
      stderr += c;
      stderrSink.write(c);
    });
    child.on('error', (error) => resolvePromise({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** The last stdout line that parses as a JSON object, or null. */
export function parseCliJson(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // not JSON: keep looking up
    }
  }
  // --json prints one object, possibly pretty-printed over several lines.
  try {
    const value = JSON.parse(String(stdout));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A clear message and exit code for a failed CLI run. */
export function mapCliFailure({ status, stderr = '' }, authUrl = '') {
  // The CLI's line for a 404 with no error body (api.ts: `The server answered ${status} ${code}: ${message}`). A JSON 404
  // (`404 NOT_FOUND: ...`), an npm registry 404 and any text that merely contains "404" or "not found" do not match.
  if (status === 1 && /^error: The server answered 404 UNKNOWN: no message$/m.test(stderr)) {
    return {
      exit: 1,
      message:
        `The deployment answered 404 for the service-principal routes on ${authUrl || 'the authorization server'}; the principal was not created. Ask the deployment's operator to serve them on the authorization server's origin.`,
    };
  }
  switch (status) {
    case 2:
      return { exit: 2, message: 'The CLI refused the input (see its message above). Nothing was created.' };
    case 3:
      return { exit: 3, message: 'Sign-in for the administrator did not complete (failed, timed out or cancelled). Run it again.' };
    case 4:
      return { exit: 4, message: 'You are not an administrator of that organization. Ask an administrator to run this.' };
    default:
      return { exit: 1, message: `The CLI failed${status === null ? '' : ` (exit ${status})`}; see its message above.` };
  }
}

/** Runs the whole subcommand. `run`, `discover` and the output sinks are injectable. Returns the exit code. */
export async function runServicePrincipal({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  discover = discoverAuthServer,
  run = runCli,
  log = console.error,
  print = console.log,
}) {
  let inputs;
  try {
    inputs = await resolveServicePrincipalInputs({ flags, env, cwd, home, discover });
  } catch (err) {
    if (!(err instanceof ServicePrincipalError)) throw err;
    log(err.message);
    return err.exit;
  }
  if (inputs.defaultOut) mkdirSync(dirname(inputs.out), { recursive: true, mode: 0o700 });
  log(`Creating service principal "${inputs.name}" in organization ${inputs.orgId} (CLI ${CLI_PACKAGE}@${CLI_VERSION}). A sign-in link follows; open it as the organization's administrator.`);
  const result = await run(buildCliArgs(inputs), { env });
  if (result.error) {
    log(`Could not run npx: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    const failure = mapCliFailure(result, inputs.authUrl);
    log(failure.message);
    return failure.exit;
  }
  const created = parseCliJson(result.stdout);
  const spId = typeof created?.sp_id === 'string' ? created.sp_id : '';
  if (!spId) {
    log('The CLI reported success but printed no sp_id. Run `npx -y @noblecloak/cli@' + CLI_VERSION + ' sp list --org ' + inputs.orgId + '` to find the principal.');
    return 1;
  }
  const path = typeof created.path === 'string' && created.path ? created.path : inputs.out;
  print(
    [
      `Service principal created: ${spId}`,
      `Credential file (holds a private key; never commit or print it): ${path}`,
      '',
      'Environment for the agent:',
      `NOBLECLOAK_SP_CREDENTIALS=${path}`,
      `NC_EXPECTED_PRINCIPAL=${spId}`,
      `NC_BASE_URL=${inputs.governAudience}`,
    ].join('\n')
  );
  return 0;
}
