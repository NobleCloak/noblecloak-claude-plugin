# Contributing to the NobleCloak Claude Code plugin

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds the line. There is no CLA.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(hooks): …`, `fix(login): …`,
`chore: …`, `docs: …`.

## Running the tests

```sh
npm ci
npm test                    # node --test over test/*.test.mjs
claude plugin validate .    # needs the Claude Code CLI
```

The tests start local stub servers and use no network and no credentials.

## Releases

`version` in `.claude-plugin/plugin.json` must change for installed users to receive an update.
