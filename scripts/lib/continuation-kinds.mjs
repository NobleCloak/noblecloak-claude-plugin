/**
 * Contract rev 17 `Capabilities.continuation_kinds`: the continuation kinds a deployment accepts. Absent means the
 * seven kinds of rev 16 (adk, langgraph, vercel_ai, openai_agents, webhook, mcp_held, agt), not "all kinds".
 * This is the pure decision; propose-tool.mjs does the (best-effort) GET /v1/capabilities.
 */

export const CONTINUATION_KIND = 'mcp_held';
export const REV16_CONTINUATION_KINDS = ['adk', 'langgraph', 'vercel_ai', 'openai_agents', 'webhook', 'mcp_held', 'agt'];

/**
 * Decide from a GET /v1/capabilities body (the `{data, meta}` envelope, or the bare Capabilities) whether the
 * deployment accepts `kind`. Returns { ok: true } or { ok: false, advertised }. Anything unreadable (not an
 * object, `continuation_kinds` absent or not an array of strings) is { ok: true }: the deployment stays the
 * authority and refuses at POST time. An explicit list of strings decides, including `[]`: the contract requires
 * at least one item, so an empty list is non-conformant, and it is refused here (the langgraph-ts adapter does the same).
 */
export function continuationKindDecision(capabilities, kind = CONTINUATION_KIND) {
  // Envelope when there is a `data` key (even null: then nothing is read); a bare Capabilities only without one.
  const caps = capabilities !== null && typeof capabilities === 'object' && 'data' in capabilities ? capabilities.data : capabilities;
  const kinds = caps?.continuation_kinds;
  if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === 'string')) return { ok: true };
  return kinds.includes(kind) ? { ok: true } : { ok: false, advertised: kinds };
}
