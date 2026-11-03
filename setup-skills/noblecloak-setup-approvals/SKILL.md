---
name: approvals
description: Wire the NobleCloak Approvals module into a Next.js App Router app, so people can see and approve or deny the requests that wait on them. Use when the user wants an approvals inbox, an approve/deny page, "human approval" UI or NobleCloak sign-in in a Next.js project.
---

# Add the Approvals module to a Next.js app

This skill adds an `/approvals` page (the queue and the detail of one request, with Approve and Deny), the
sign-in callback at `/approvals/callback`, and a token getter, to an existing Next.js App Router project. It
installs `@noblecloak/react`. Its script adds files under `app/approvals/`, keys to `.env.example`, and
`!.env.example` to `.gitignore` when a `.env*` rule there would keep that file out of git; the script touches no middleware, no root layout and no framework configuration. One change is the user's to make
by hand: the callback route's two response headers go in the project's Next.js configuration (step 4).

## Before you start

- The project is a Next.js App Router app (`app/` or `src/app/`, with `next` in `package.json`) on React 19.
  Stop and say so if it is not; the skill does not cover the Pages Router or other frameworks.
- Ask the user for the approvals API's origin (for example `https://govern.example.test`). For sign-in they
  also need the issuer, a public client id and the redirect URI; for a local trial against NobleCloak's mock
  server only the API origin is needed.

## Steps

1. Run the script from the project's root. It copies the files, adds the environment keys to `.env.example`
   (un-ignoring it in `.gitignore` if a `.env*` rule there, as in a fresh `create-next-app`, ignores it), and
   installs the package with the project's package manager (the `packageManager` field of its
   `package.json`, else the nearest lockfile in the project or a directory above it, as in a workspace;
   npm when there is neither):

   ```sh
   node <this skill's directory>/scripts/apply.mjs
   ```

   It refuses to overwrite a file that exists with other content and writes nothing then; show the user the
   list and ask before using `--force`. `--dry-run` prints what it would do. `--project <dir>` names another
   project directory. `--skip-install` leaves the install to you (`bun add @noblecloak/react`, or the same
   with npm, pnpm or yarn).

   `--source <dir of tarballs>` is for pre-release testing by NobleCloak, not for users: it installs the
   `@noblecloak/react`, `@noblecloak/client` and `@noblecloak/theme` tarballs in that directory, and it edits
   `package.json` to pin `@noblecloak/client` and `@noblecloak/theme` to their tarballs through the manager's
   override field, keeping the file's indent.
   Only the bun path has been run against a real install; the npm, pnpm and yarn paths are covered by
   dry-run tests. Users take the default, `--source registry`.

2. Tell the user which files were created under `app/approvals/`:

   | File                                      | What it is                                                        |
   | ----------------------------------------- | ----------------------------------------------------------------- |
   | `layout.tsx`                              | wraps the route and imports `@noblecloak/react/styles.css`        |
   | `page.tsx`                                | the route; reads the configuration and shows the inbox            |
   | `ApprovalsExample.tsx`                    | the provider: `useApprovals` with the token getter, `<Approvals>` |
   | `auth.ts`                                 | the one browser sign-in object (`createBrowserAuth`) of the page  |
   | `config.ts`                               | reads and checks the `NEXT_PUBLIC_NC_*` variables                 |
   | `ConfigProblem.tsx`                       | what the page shows when a variable is missing or malformed       |
   | `CallbackClient.tsx`, `callback/page.tsx` | the sign-in callback; goes on to `/approvals` once it worked      |

   The files are copies of NobleCloak's example app, so their names (`ApprovalsExample`,
   `ExampleConfig`) and some comments speak of "the example" and of tests; the skill ships no tests. Rename
   or reword them freely, they are the project's now.

3. Configure it. Copy `.env.example` to `.env.local` and fill in the values. `NEXT_PUBLIC_*` values are
   inlined by `next build`, so a change needs a rebuild. The redirect URI must be exactly
   `<the app's origin>/approvals/callback`, registered with the sign-in service, and the API must let the
   app's exact origin call it.
   - Sign-in (the default): `NEXT_PUBLIC_NC_API_URL`, `NEXT_PUBLIC_NC_ISSUER`, `NEXT_PUBLIC_NC_CLIENT_ID`,
     `NEXT_PUBLIC_NC_REDIRECT_URI`. The API URL is an origin: `https:` or `http://localhost`, no path.
   - Mock (local trial, no sign-in): `NEXT_PUBLIC_NC_MODE=mock` and `NEXT_PUBLIC_NC_API_URL` set to the mock's
     origin, for example `http://127.0.0.1:8787`. The page then takes the approver's token from the mock and
     says so in a banner. Never use this mode against a real deployment.

4. Add the callback route's response headers. The sign-in redirect lands on `/approvals/callback` with the
   authorization code in its address, so that response must not be cached and its address must not be sent on
   as a referrer. The script does not edit the project's configuration; tell the user to add this to
   `next.config.ts` (or `next.config.js`/`.mjs`), merging it into an existing `headers()` if there is one:

   ```ts
   headers() {
     return Promise.resolve([
       {
         source: '/approvals/callback',
         headers: [
           { key: 'Cache-Control', value: 'no-store' },
           { key: 'Referrer-Policy', value: 'no-referrer' },
         ],
       },
     ]);
   },
   ```

   Mock mode never redirects there, but the headers belong on the route before sign-in is turned on.

5. Build and open the page: `next build`, then `next start`, and visit `/approvals`. Signed out, it shows a
   "Sign in" button; signed in (or in mock mode), the requests waiting on the person appear and update live.

## What is not here yet

The skill does not add a content-security policy, a Next.js `proxy.ts`/middleware, a health route or the
callback route's `Cache-Control`/`Referrer-Policy` headers (step 4 has the user add those by hand); it does
not change the root layout. They are the next step: the aim is for the skill to provide the whole approvals
surface. If the project has a content-security policy, it must allow the page's scripts, and its
`connect-src` must list the API's origin and, for sign-in, the issuer's origin (the module calls the issuer's
metadata, token and revocation endpoints). Theme slots are not part of this version.

## Check that it worked

- `next build` passes and `/approvals` renders without a console error.
- With a missing variable the page says "This app is not configured" and lists the variables (that is the
  intended failure, not a crash).
