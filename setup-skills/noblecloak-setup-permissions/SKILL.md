---
name: permissions
description: Wire the NobleCloak Permissions module into a Next.js App Router app, so administrators can see and edit which tool calls each role may make (always allow, ask, escalate, deny, not granted), draft, dry-run and publish tool policies. Use when the user wants a permissions page, a role × tool policy table, a policy editor or NobleCloak tool policies in a Next.js project.
---

# Add the Permissions module to a Next.js app

This skill adds a `/permissions` page (the role × tool table of tool policies, the editor of one policy, a dry run
of it for the signed-in person, and the drafts, with Publish where the service offers it), the sign-in callback at
`/permissions/callback`, and a token getter, to an existing Next.js App Router project. It installs
`@noblecloak/react`. Its script adds files under `app/permissions/`, keys to `.env.example`, and `!.env.example` to
`.gitignore` when a `.env*` rule there would keep that file out of git; the script touches no middleware, no root
layout and no framework configuration. One change is the user's to make by hand: the callback route's two
response headers go in the project's Next.js configuration (step 4).

## Before you start

- The project is a Next.js App Router app (`app/` or `src/app/`, with `next` in `package.json`) on React 19.
  Stop and say so if it is not; the skill does not cover the Pages Router or other frameworks.
- Ask the user for the API's origin (for example `https://govern.example.test`). For sign-in they also need the
  issuer, a public client id and the redirect URI; for a local trial against NobleCloak's mock server only the API
  origin is needed.
- Ask which roles to show as columns (their keys, for example `member,admin`). The table also shows every role a
  policy names, but a role no policy names appears only if it is listed: not every service lists roles.

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
   yarn).

   `--source <dir of tarballs>` is for pre-release testing by NobleCloak, not for users: it installs the
   `@noblecloak/react`, `@noblecloak/client` and `@noblecloak/theme` tarballs in that directory and pins the last
   two to their tarballs through the manager's override field. Users take the default, `--source registry`.

2. Tell the user which files were created under `app/permissions/`:

   | File                                      | What it is                                                                   |
   | ----------------------------------------- | ---------------------------------------------------------------------------- |
   | `layout.tsx`                              | wraps the route and imports `@noblecloak/react/styles.css`                   |
   | `page.tsx`                                | the route; reads the configuration and shows the table                       |
   | `PermissionsExample.tsx`                  | the provider: `usePolicies` with the token getter and roles, `<Permissions>` |
   | `auth.ts`                                 | the one browser sign-in object (`createBrowserAuth`) of the page             |
   | `config.ts`                               | reads and checks the `NEXT_PUBLIC_NC_*` variables                            |
   | `ConfigProblem.tsx`                       | what the page shows when a variable is missing or malformed                  |
   | `CallbackClient.tsx`, `callback/page.tsx` | the sign-in callback; goes on to `/permissions` once it worked               |

   The files are copies of NobleCloak's example app, so their names (`PermissionsExample`, `ExampleConfig`) and some
   comments speak of "the example" and of tests; the skill ships no tests. Rename or reword them freely.

3. Configure it. Copy `.env.example` to `.env.local` and fill in the values. `NEXT_PUBLIC_*` values are inlined by
   `next build`, so a change needs a rebuild. The redirect URI must be exactly
   `<the app's origin>/permissions/callback`, registered with the sign-in service, and the API must let the app's
   exact origin call it.
   - Sign-in (the default): `NEXT_PUBLIC_NC_API_URL`, `NEXT_PUBLIC_NC_ISSUER`, `NEXT_PUBLIC_NC_CLIENT_ID`,
     `NEXT_PUBLIC_NC_PERMISSIONS_REDIRECT_URI`. The API URL is an origin: `https:` or `http://localhost`, no path.
   - Roles: `NEXT_PUBLIC_NC_ROLES`, comma-separated role keys, shown as columns before the roles the policies name.
   - Mock (local trial, no sign-in): `NEXT_PUBLIC_NC_MODE=mock` and `NEXT_PUBLIC_NC_API_URL` set to the mock's
     origin, for example `http://127.0.0.1:8787`. The page then takes the mock's administrator token and says so in
     a banner. Never use this mode against a real deployment.

4. Add the callback route's response headers. The sign-in redirect lands on `/permissions/callback` with the
   authorization code in its address, so that response must not be cached and its address must not be sent on as a
   referrer. Tell the user to add this to `next.config.ts` (or `.js`/`.mjs`), merging it into an existing
   `headers()`:

   ```ts
   headers() {
     return Promise.resolve([
       {
         source: '/permissions/callback',
         headers: [
           { key: 'Cache-Control', value: 'no-store' },
           { key: 'Referrer-Policy', value: 'no-referrer' },
         ],
       },
     ]);
   },
   ```

5. Build and open the page: `next build`, then `next start`, and visit `/permissions`. Signed out, it shows a
   "Sign in" button; signed in (or in mock mode), the table of tool policies appears.

## What the page does and does not say

- A cell shows the published policy that governs that role and tool (its mode, name, version and author), or
  "No policy" and that the deployment's default applies. The cell itself never shows what a person holding the role
  actually gets; the "Effective access" view does, for an administrator, through a dry run as each role (it names
  what set a cell only where the service states how policies combine).
- Every mode it offers is one of the five the contract defines. A service that does not enforce a mode (for example
  `escalate` or the provisional `not_granted`) refuses it, and the page shows the service's reason next to the field it names, or above the editor.
- Authoring follows the service: where it does not offer authoring or publishing, those controls are absent. A
  person who is not an administrator sees the table read-only after the first refusal; pass `readOnly` to
  `usePolicies` when the app already knows.
- An open policy's dry run answers for the signed-in person; the "Effective access" view runs one as each role and
  as the organisation, which the service allows administrators only.
- Where the service advertises `policies.retire`, an administrator retires a published policy (from its cell, back to
  no policy, or from its editor) and discards a draft (from the Drafts tray or the editor), each after a confirm that
  says what it does: a retired policy keeps its history, and once the service's policy-cache interval has passed it is not enforced and
  no new decision names it.

## What is not here yet

The skill does not add a content-security policy, a Next.js `proxy.ts`/middleware or the callback route's headers
(step 4); it does not change the root layout. If the project has a content-security policy, its `connect-src` must
list the API's origin and, for sign-in, the issuer's origin. An app that also has the approvals page holds one
sign-in object per page; sharing one between them is a later step. Theme slots are not part of this version.

## Check that it worked

- `next build` passes and `/permissions` renders without a console error.
- With a missing variable the page says "This app is not configured" and lists the variables.
