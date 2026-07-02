// DO stub helpers — the `idFromName + get + fetch(new Request(...))` dance for
// pushing to a user's StatusHub / a pairing's LinkBroker / the Miner singleton
// used to be inlined at every call site (index.js routes + miner.js). One place.

export const hubFor = (env, scope) => env.StatusHub.get(env.StatusHub.idFromName("status:" + scope));

// POST one broadcast body to a user's StatusHub. Returns the hub's Response
// (callers that must not fail on push errors wrap it — see notifyStatus).
export const hubBroadcast = (env, scope, body) =>
  hubFor(env, scope).fetch(new Request("https://status-hub/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

// Best-effort recording-status push (待处理/处理中/已成文…): a notification
// failure must never fail the pipeline. Signature matches the old miner-local
// notifyStatus so call sites are unchanged.
export async function notifyStatus(scope, stem, status, env) {
  try { await hubBroadcast(env, scope, { stem, status }); } catch (_) {}
}

export const brokerFor = (env, pairingId) => env.LinkBroker.get(env.LinkBroker.idFromName(pairingId));

// One op-call to a pairing's LinkBroker DO (create / verify / complete / cancel).
export const brokerOp = (env, pairingId, body) =>
  brokerFor(env, pairingId).fetch(new Request("https://link/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

export const minerStub = (env) => env.Miner.get(env.Miner.idFromName("miner"));
