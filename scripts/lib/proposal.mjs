/**
 * The tool-proposal shape, mirrored from the `tool:noblecloak:set-tool-policy`
 * row's input_schema in the COO API: required tool_ref /
 * side_effect_level / policy; optional input_schema / description / owner_kind /
 * show_arguments_to_approvers; additionalProperties false. The deployment
 * re-validates at open (400 invalid_request) and is authoritative; this mirror
 * only fails fast, before a sign-in or a network call.
 */

export const SET_TOOL_POLICY_REF = 'tool:noblecloak:set-tool-policy';
const RESERVED_PREFIX = 'tool:noblecloak:';
export const SIDE_EFFECT_LEVELS = ['read', 'write', 'delete', 'external', 'admin'];
export const POLICIES = ['ask', 'always_allow', 'deny'];
export const OWNER_KINDS = ['principal', 'org'];
const KEYS = [
  'tool_ref',
  'side_effect_level',
  'input_schema',
  'description',
  'owner_kind',
  'show_arguments_to_approvers',
  'policy',
];

/** Returns { ok: true, proposal } or { ok: false, code, detail } (code = the problem code the deployment would use). */
export function validateProposal(p) {
  const bad = (detail, code = 'invalid_request') => ({ ok: false, code, detail });
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return bad('the proposal must be an object');
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) return bad(`unknown member "${k}"`);
  if (typeof p.tool_ref !== 'string' || p.tool_ref.length < 1 || p.tool_ref.length > 200) {
    return bad('tool_ref is required (1-200 characters)');
  }
  if (p.tool_ref.startsWith(RESERVED_PREFIX)) {
    return bad(`tool_ref may not start with "${RESERVED_PREFIX}" (reserved to the deployment)`, 'reserved_tool_ref');
  }
  if (!SIDE_EFFECT_LEVELS.includes(p.side_effect_level)) {
    return bad(`side_effect_level is required and one of ${SIDE_EFFECT_LEVELS.join('|')}`);
  }
  if (!POLICIES.includes(p.policy)) return bad(`policy is required and one of ${POLICIES.join('|')}`);
  if (p.input_schema !== undefined && (typeof p.input_schema !== 'object' || p.input_schema === null || Array.isArray(p.input_schema))) {
    return bad('input_schema must be a JSON object');
  }
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 2000)) {
    return bad('description must be a string of at most 2000 characters');
  }
  if (p.owner_kind !== undefined && !OWNER_KINDS.includes(p.owner_kind)) {
    return bad(`owner_kind must be one of ${OWNER_KINDS.join('|')}`);
  }
  if (p.show_arguments_to_approvers !== undefined && typeof p.show_arguments_to_approvers !== 'boolean') {
    return bad('show_arguments_to_approvers must be a boolean');
  }
  return { ok: true, proposal: p };
}

/** The POST /v1/approvals body for a validated proposal. */
export function approvalRequestBody(proposal) {
  return {
    action: { tool_ref: SET_TOOL_POLICY_REF, arguments: proposal },
    // The MCP client holds the proposal; nothing resumes (the deployment applies
    // the effect on approval). Kind/delivery are from the closed sets in coo
    // module-api continuation.ts.
    continuation: {
      kind: 'mcp_held',
      delivery: 'held',
      correlation: { surface: 'noblecloak-claude-plugin', tool_ref: proposal.tool_ref },
    },
  };
}
