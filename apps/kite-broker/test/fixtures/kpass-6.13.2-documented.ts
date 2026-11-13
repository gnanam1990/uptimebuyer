// DOCUMENTED-EXAMPLE fixtures for the kpass 6.13.2 contract. These are NOT real kpass responses: each object is the JSON
// shape Kite's own installed skill documentation prints for that command (sources below, read 2026-11-13), with the
// placeholder values of those docs. Where a field is documented in prose but absent from the printed example (the
// settlement reference under payment.payment_response.reference), the fixture says so in `composedFrom`.
//   RS  = ~/.claude/skills/request-session/references/commands.md
//   X   = ~/.claude/skills/x402-execute/SKILL.md
//   XC  = ~/.claude/skills/x402-execute/references/commands.md
//   XE  = ~/.claude/skills/x402-execute/references/examples.md
//   DS  = ~/.claude/skills/form-session-delegation/references/delegation-schema.md
// Exit codes are the documented ones (X "Error Handling" table, RS "session status").

export interface DocumentedExample {
  label: 'DOCUMENTED_EXAMPLE';
  source: string;
  exitCode: number;
  json: Record<string, unknown>;
  composedFrom?: string;
}

const ex = (source: string, exitCode: number, json: Record<string, unknown>, composedFrom?: string) =>
  Object.freeze({
    label: 'DOCUMENTED_EXAMPLE' as const,
    source,
    exitCode,
    json,
    ...(composedFrom ? { composedFrom } : {}),
  });

export const KPASS = Object.freeze({
  /** RS "session create … Request Created Output (exit code 0)". */
  sessionCreateRequested: ex('RS session create: Request Created Output', 0, {
    action: 'approve_session',
    request_id: 'req_abc123',
    approval_url: 'https://agentpassport.ai/agent-session/approve?token=documented-placeholder-token',
    expires_at: '2026-10-23T12:10:00Z',
    user_message:
      'I opened the approval page in your browser. If it did not open, use this link: https://agentpassport.ai/agent-session/approve?token=documented-placeholder-token It allows up to USD 0.001 per call and USD 0.002 in total for 1 hour. The link expires in 10 minutes.',
    reply_first: true,
    browser_opened: true,
    wait_command: 'kpass session status --request-id req_abc123 --wait --output json',
    _version: '1',
    status: 'human_action_required',
    hint: 'Put user_message in your reply now. After the reply, run wait_command.',
    next_command: '',
  }),
  /** RS "Reuse Available Output (exit code 0)": no request was created. */
  sessionCreateReuseAvailable: ex('RS session create: Reuse Available Output', 0, {
    reuse_available: true,
    reuse_candidates: [
      {
        session_id: 'session_xyz789',
        expires_at: '2026-03-17T13:00:00Z',
        max_amount_per_tx: '5.00',
        remaining_budget: '40',
        task_summary: 'Query the weather forecast API at weather.example.com.',
      },
    ],
    _version: '1',
    status: 'success',
    hint: 'Detected 1 existing active session(s) that cover this request.',
    next_command: 'kpass session use --session-id session_xyz789 --output json',
  }),
  /** RS "session status … Approved Output (exit code 0)". */
  sessionStatusApproved: ex('RS session status: Approved Output', 0, {
    request_id: 'req_abc123',
    session_id: 'session_xyz789',
    session: {
      id: 'session_xyz789',
      status: 'active',
      expires_at: '2026-03-17T13:00:00Z',
      delegation: {
        task: { summary: 'Query the weather API for forecasts.' },
        payment_policy: { max_amount_per_tx: '5.00', max_total_amount: '50.00' },
      },
      usage: { spent_total: '0.00', reserved_total: '0.00' },
    },
    current_session_id: 'session_xyz789',
    _version: '1',
    status: 'success',
    hint: 'Session approved and set as current. Expires at 2026-03-17T13:00:00Z.',
    next_command: '',
  }),
  /** RS "Pending Output (exit code 0)". */
  sessionStatusPending: ex('RS session status: Pending Output', 0, {
    request_id: 'req_abc123',
    expires_at: '2026-03-17T12:05:00Z',
    _version: '1',
    status: 'pending',
    user_message: 'Approve it with your passkey at this link: https://... The link expires in 4 minutes.',
    reply_first: true,
    wait_command: 'kpass session status --request-id req_abc123 --wait --output json',
    hint: 'Session request is still pending approval.',
    next_command: '',
  }),
  /** RS "Rejected Output (exit code 3)". */
  sessionStatusRejected: ex('RS session status: Rejected Output', 3, {
    _version: '1',
    status: 'error',
    error: 'Session request was rejected by the user.',
    hint: 'The user said no to this request.',
    next_command: 'kpass session create --output json',
  }),
  /** RS "Expired Output (exit code 3)". */
  sessionStatusExpired: ex('RS session status: Expired Output', 3, {
    _version: '1',
    status: 'error',
    error: 'Session request expired before approval.',
    hint: 'The approval link expired.',
    next_command: 'kpass session create --output json',
  }),
  /** XC "session execute … Success Output (exit code 0)" (paid from a separately approved session). */
  executeSuccess: ex('XC session execute: Success Output', 0, {
    session_id: 'session_xyz789',
    session_status: 'active',
    delegation: {
      task: { summary: 'Query the weather forecast API at weather.example.com.' },
      payment_policy: { max_amount_per_tx: '5.00', max_total_amount: '50.00' },
    },
    usage: { spent_total: '6.00', reserved_total: '0.00' },
    payment_requirement: { asset: 'USDC', amount: '1.00' },
    x402: {
      status_code: 200,
      response_body: '{"forecast": "sunny, 72F"}',
      parsed_response_body: { forecast: 'sunny, 72F' },
      wallet_address: '0xabc123...',
      chain_id: 8453,
    },
    _version: '1',
    status: 'success',
    hint: 'x402 request to https://weather.example.com/v1/forecast completed with HTTP 200.',
    next_command: '',
  }),
  /** XE "Pay From the Account Allowance" (abridged in the docs): `source: "allowance"`. */
  executeFromAllowance: ex('XE Pay From the Account Allowance', 0, {
    status: 'success',
    source: 'allowance',
    allowance_id: 'allow_abc',
    user_message: 'Paid USD 0.001 from your account allowance.',
    x402: { status_code: 200, parsed_response_body: { temp_f: 71 } },
  }),
  /** X exit 7 "Payment outcome not known yet". */
  executePending: ex(
    'X Error Handling exit 7 payment_outcome_pending',
    7,
    {
      _version: '1',
      status: 'error',
      error: 'Payment outcome pending',
      error_code: 'payment_outcome_pending',
      retriable: true,
      details: { retry_after_seconds: 60 },
      hint: 'Retry once later with next_command.',
      next_command: 'kpass session execute … --idempotency-key <same key> --output json',
    },
    'error envelope fields (XC "Error envelope fields") + exit 7 row',
  ),
  /** X exit 7 "Merchant failed after payment": the amount is held. */
  executeMerchantFailedHeld: ex(
    'X Error Handling exit 7 merchant_failed_held',
    7,
    {
      _version: '1',
      status: 'error',
      error: 'Merchant failed after payment',
      error_code: 'recurring_payment_unknown',
      retriable: true,
      details: { outcome: 'merchant_failed_held', payment_id: 'pay_documented', held_amount: '0.01' },
      next_command: 'kpass session updates --wait --payment-id pay_documented --output json',
    },
    'XC "Merchant failed after payment" bullet list',
  ),
  /** X exit 6 wallet_empty: "nothing was paid or charged" (backend v3.4.5 and later). */
  executeWalletEmpty: ex(
    'X Error Handling exit 6 wallet_empty',
    6,
    {
      _version: '1',
      status: 'error',
      error: 'Wallet empty',
      error_code: 'wallet_empty',
      details: { reason: 'empty', balance: '0', required: '0.01' },
      user_message: 'Your Passport wallet has no funds.',
      next_command: 'kpass session execute … --output json',
    },
    'XC "Wallet empty" bullet list',
  ),
  /** X exit 6 session_rule_exceeded (a policy refusal whose no-effect is NOT documented). */
  executeSessionRuleExceeded: ex(
    'X Error Handling exit 6 session_rule_exceeded',
    6,
    {
      _version: '1',
      status: 'error',
      error: 'Amount exceeds per-transaction limit',
      error_code: 'session_rule_exceeded',
    },
    'XC "Amount exceeds per-transaction limit"',
  ),
  /** X exit 2 idempotency_key_required: "Nothing was sent". */
  executeIdempotencyKeyRequired: ex(
    'X Error Handling exit 2 idempotency_key_required',
    2,
    {
      _version: '1',
      status: 'error',
      error: 'Payments from the account allowance need --idempotency-key',
      error_code: 'idempotency_key_required',
      next_command: 'kpass session execute … --idempotency-key <new key> --output json',
    },
    'XC "Payments from the account allowance need --idempotency-key"',
  ),
  /** XC exit 2 no_payment_requirement: the merchant returned no x402 challenge, nothing to pay. */
  executeNoPaymentRequirement: ex(
    'XC exit 2 no_payment_requirement',
    2,
    { _version: '1', status: 'error', error: 'No payment requirement', error_code: 'no_payment_requirement' },
    'XC "No payment requirement"',
  ),
  /** XC cross-chain table: payment_settled_unfulfilled, exit 1, charged and unfulfilled. */
  executeSettledUnfulfilled: ex(
    'XC Cross-Chain Routing Errors payment_settled_unfulfilled',
    1,
    {
      _version: '1',
      status: 'error',
      error: 'payment settled, merchant did not fulfil',
      error_code: 'payment_settled_unfulfilled',
      merchant_body: '{"error":"bad request"}',
    },
    'XC routing table row + X rule 4 (merchant_body)',
  ),
});

/** The documented success envelope with the settlement reference X "How to Verify a Payment Settled" names. */
export const executeSuccessWithReference = (over: { amount: string; sessionId: string; body: string }) => ({
  ...KPASS.executeSuccess.json,
  session_id: over.sessionId,
  usage: { spent_total: over.amount, reserved_total: '0.00' },
  payment_requirement: { asset: 'USDC', amount: over.amount },
  payment: {
    payment_response: { reference: `0x${'ab'.repeat(32)}` },
  },
  x402: {
    ...(KPASS.executeSuccess.json.x402 as object),
    response_body: over.body,
    parsed_response_body: JSON.parse(over.body),
  },
});
