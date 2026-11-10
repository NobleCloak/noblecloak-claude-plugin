# Provenance

**From 2026-11-09 changes are authored in `bianoble/noblecloak-claude-plugin-dev`** and reviewed there, then
promoted to this repository by a pull request (the first was #15, plugin 0.2.7). This repository's `main` is
what the marketplace installs, so merging a promotion is the release. After each promotion the `-dev`
repository merges this `main` back, so both carry the same tree.

**2026-11-07 to 2026-11-08.** This repository was the authoring repository: changes were proposed and
reviewed here (#12 and #13), and the `-dev` repository was fast-forwarded to this `main` after each merge.

**History before that.** Exported from the private authoring repository at commit `210f3591ffdeb14cb0025752a8755dee771609de`, with no git history, by an export
script that stays in that repository. The export removes internal planning documents and tooling, adds
the licence and community files, points the skill and release sources at the NobleCloak repositories, and
drops the private labelling workflow. Beyond the repositories `/noblecloak-setup` downloads release tarballs
from, it changes no plugin behaviour. The commit trail stays in the source repository.

The shas in `setup-skills/SKILLS.lock` are commits of the repositories each entry names.
