---
name: connections
description: Wire the NobleCloak Connections module into a Next.js App Router app, so administrators can register MCP tool servers and refresh their tools, and every person can link a credential of their own to a registered server with explicit, revocable consent. Use when the user wants a connections page, a tool-server registration screen, "link my account" for MCP servers, or NobleCloak connections in a Next.js project.
---

# Add the Connections module to a Next.js app

This skill adds a `/connections` page (the tool servers the organisation has registered, the form to register one,
and for an open registration its tools, the changes an administrator makes and the person's own credential), the
sign-in callback at `/connections/callback`, and a token getter, to an existing Next.js App Router project. It
installs `@noblecloak/react`. Its script adds files under `app/connections/`, keys to `.env.example`, and
`!.env.example` to `.gitignore` when a `.env*` rule there would keep that file out of git; the script touches no
middleware, no root layout and no framework configuration. One change is the user's to make by hand: the callback
route's two response headers go in the project's Next.js configuration (step 4).

## Before you start

- The project is a Next.js App Router app (`app/` or `src/app/`, with `next` in `package.json`) on React 19.
  Stop and say so if it is not; the skill does not cover the Pages Router or other frameworks.
- Ask the user for the API's origin (for example `https://govern.example.test`). For sign-in they also need the
  issuer, a public client id and the redirect URI; for a local trial against NobleCloak's mock server only the API
  origin is needed.
- The page's own origin must be one the service lets a browser module return to: an OAuth link leaves the page for
  the authorization server and comes back to it.

## Steps

1. Run the script from the project's root. It copies the files, adds the environment keys to `.env.example`
   (un-ignoring it in `.gitignore` if a `.env*` rule there ignores it), and installs the package with the project's
   package manager (the `packageManager` field of its `package.json`, else the nearest lockfile in the project or a
   directory above it; npm when there is neither):

   ```sh
   node <this skill's directory>/scripts/apply.mjs
   ```

   It refuses to overwrite a file that exists with other content and writes nothing then; show the user the list and
   ask before using `--force`. `--dry-run` prints what it would do. `--project <dir>` names another project
   directory. `--skip-install` leaves the install to you (`bun add @noblecloak/react`, or the same with npm, pnpm or
   yarn). Keys `.env.example` already has (another NobleCloak page's API origin, issuer, client id) are kept.

   `--source <dir of tarballs>` is for pre-release testing by NobleCloak, not for users: it installs the
   `@noblecloak/react`, `@noblecloak/client` and `@noblecloak/theme` tarballs in that directory and pins the last
   two to their tarballs through the manager's override field. Users take the default, `--source registry`.

2. Tell the user which files were created under `app/connections/`:

   | File                                      | What it is                                                            |
   | ----------------------------------------- | --------------------------------------------------------------------- |
   | `layout.tsx`                              | wraps the route and imports `@noblecloak/react/styles.css`            |
   | `page.tsx`                                | the route; reads the configuration and shows the module               |
   | `ConnectionsExample.tsx`                  | the provider: `useConnections` with the token getter, `<Connections>` |
   | `auth.ts`                                 | the one browser sign-in object (`createBrowserAuth`) of the page      |
   | `config.ts`                               | reads and checks the `NEXT_PUBLIC_NC_*` variables                     |
   | `ConfigProblem.tsx`                       | what the page shows when a variable is missing or malformed           |
   | `CallbackClient.tsx`, `callback/page.tsx` | the sign-in callback; goes on to `/connections` once it worked        |

   The files are copies of NobleCloak's example app, so their names (`ConnectionsExample`, `ExampleConfig`) and some
   comments speak of "the example" and of tests; the skill ships no tests. Rename or reword them freely.

3. Configure it. Copy `.env.example` to `.env.local` and fill in the values. `NEXT_PUBLIC_*` values are inlined by
   `next build`, so a change needs a rebuild. The redirect URI must be exactly
   `<the app's origin>/connections/callback`, registered with the sign-in service, and the API must let the app's
   exact origin call it.
   - Sign-in (the default): `NEXT_PUBLIC_NC_API_URL`, `NEXT_PUBLIC_NC_ISSUER`, `NEXT_PUBLIC_NC_CLIENT_ID`,
     `NEXT_PUBLIC_NC_CONNECTIONS_REDIRECT_URI`. The API URL is an origin: `https:` or `http://localhost`, no path.
     The redirect key is this page's own, so an app that also has the approvals or permissions page sends each
     page's sign-in back to its own callback.
   - Mock (local trial, no sign-in): `NEXT_PUBLIC_NC_MODE=mock` and `NEXT_PUBLIC_NC_API_URL` set to the mock's
     origin, for example `http://127.0.0.1:8787`. The page then takes the mock's administrator token and says so in
     a banner. Never use this mode against a real deployment.

4. Add the callback route's response headers. The sign-in redirect lands on `/connections/callback` with the
   authorization code in its address, so that response must not be cached and its address must not be sent on as a
   referrer. Tell the user to add this to `next.config.ts` (or `.js`/`.mjs`), merging it into an existing
   `headers()`:

   ```ts
   headers() {
     return Promise.resolve([
       {
         source: '/connections/callback',
         headers: [
           { key: 'Cache-Control', value: 'no-store' },
           { key: 'Referrer-Policy', value: 'no-referrer' },
         ],
       },
     ]);
   },
   ```

5. Build and open the page: `next build`, then `next start`, and visit `/connections`. Signed out, it shows a
   "Sign in" button; signed in (or in mock mode), the registered tool servers appear.

## What the page does and does not do

- It offers only what the service advertises in its capabilities: no OAuth option where the OAuth round trip is
  not offered, no "my credential" part where per-user links are not, and a neutral "not available here" panel where
  connections are not served at all.
- Changing or deleting a registration the organisation owns, and its organisation credential, is an
  administrator's act on every service; registering is too where the service says only administrators register. A
  person who is not an administrator is told so after the first refusal, and the page stops offering those changes;
  pass `readOnly` to `useConnections` when the app already knows. A person still changes the registrations they own.
- A server's URL identifies it and its tools: it cannot be changed. Deleting a registration withdraws its tools
  (their policies stay) and removes every person's link to it; registering the same URL again brings them back.
- Each person links a credential of their own, only after ticking an explicit consent, and can revoke that consent
  or unlink at any time; the page says each time that the tools stay available to others. It never shows another
  person's link, and it never shows a credential: tokens are typed into write-only fields and sent once.
- An OAuth link leaves the page and comes back with the result, which the page shows once, only for an
  authorization this browser started, and then takes out of the address.

## What is not here yet

The skill does not add a content-security policy, a Next.js `proxy.ts`/middleware or the callback route's headers
(step 4); it does not change the root layout. If the project has a content-security policy, its `connect-src` must
list the API's origin and, for sign-in, the issuer's origin. An app that also has the approvals or permissions page
holds one sign-in object per page; sharing one between them is a later step.

## Check that it worked

- `next build` passes and `/connections` renders without a console error.
- With a missing variable the page says "This app is not configured" and lists the variables.
