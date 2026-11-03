#!/usr/bin/env node
/**
 * Disconnect from NobleCloak — clear the governance token (auth.json).
 *
 * The committed, tokenless .mcp.json is left untouched: the MCP connection is
 * Claude Code's own native OAuth, which it manages independently (use Claude
 * Code to disconnect the MCP server itself).
 */

import { unlinkSync, existsSync } from 'node:fs';
import { authFilePath, clearSignedOut, migrateLegacyState } from './lib/governance.mjs';

// Migrate first: a pre-rename sign-in not yet moved would otherwise survive this
// logout and be moved in (signing the user back in) by the next hook or status run.
// Once migrated, the marker keeps later runs from moving anything in again.
try {
  migrateLegacyState();
} catch {
  // best effort: still clear whatever is in the state directory
}
const authFile = authFilePath();
if (existsSync(authFile)) {
  unlinkSync(authFile);
  console.log('Governance token cleared (auth.json).');
}
// Logged out (no auth.json) is its own state; a stale signed-out marker would
// otherwise outlive the session it described.
clearSignedOut();

console.log('\nDisconnected from NobleCloak governance. Run /noblecloak-login to reconnect.');
