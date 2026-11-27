// End-to-end API check against a running server: `npm run dev`, then `npm run smoke`.
// Set BASE to test a deployed copy, and STRIPE_WEBHOOK_SECRET to include the webhook test.
import { createHmac } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8787";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_local_test";
let failures = 0;

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}

async function call(path, { method = "GET", token, body, raw, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined)
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const created = await call("/api/circles", { method: "POST", body: { parentName: "Mom", yourName: "Sarah" } });
check("organizer creates a circle", created.status === 201 && created.data.token, JSON.stringify(created));
const sarah = created.data.token;

const noAuth = await call("/api/state");
check("state needs a token", noAuth.status === 401);

const inv = await call("/api/invites", { method: "POST", token: sarah, body: { role: "Family" } });
check("organizer makes a family invite", inv.status === 201 && inv.data.code, JSON.stringify(inv));
const info = await call(`/api/invites/${inv.data.code}`);
check("invite shows who invited", info.data && info.data.invitedBy === "Sarah" && info.data.parentName === "Mom", JSON.stringify(info));
const mike = (await call(`/api/invites/${inv.data.code}/join`, { method: "POST", body: { name: "Mike" } })).data.token;
check("brother joins with just a name", Boolean(mike));
const jen = (await call(`/api/invites/${inv.data.code}/join`, { method: "POST", body: { name: "Jen" } })).data.token;
check("same link works for a second sibling", Boolean(jen));

const aideInv = await call("/api/invites", { method: "POST", token: sarah, body: { role: "Aide" } });
const rosaJoin = await call(`/api/invites/${aideInv.data.code}/join`, { method: "POST", body: { name: "Rosa" } });
const rosa = rosaJoin.data.token;
check("aide joins", Boolean(rosa));

const day = new Date().toISOString().slice(0, 10);
const put = await call("/api/records", {
  method: "POST",
  token: sarah,
  body: { ops: [{ kind: "med", id: "m1", data: { name: "Lisinopril", dose: "10 mg", times: ["08:00"], left: 30, countedAt: Date.now() } }] }
});
check("organizer adds a med", put.status === 200 && put.data.saved === 1, JSON.stringify(put));
const dose = await call("/api/records", { method: "POST", token: rosa, body: { ops: [{ kind: "dose", id: `${day}|m1|08:00`, data: { medId: "m1", by: "x", at: Date.now() } }] } });
check("aide checks off a dose", dose.status === 200);

const mikeState = await call("/api/state", { token: mike });
const kinds = mikeState.data.records.map((r) => r.kind).sort().join(",");
check("brother sees the med and the dose", kinds === "dose,med", kinds);
check("brother sees 4 members", mikeState.data.members.length === 4, mikeState.data.members.length);

const delta = await call(`/api/state?since=${mikeState.data.now + 5000}`, { token: mike });
check("incremental sync returns nothing new", delta.data.records.length === 0, delta.data.records.length);

const blockedExpense = await call("/api/records", { method: "POST", token: sarah, body: { ops: [{ kind: "expense", id: "e1", data: { amt: 10 } }] } });
check("expenses need Family Plus", blockedExpense.status === 402, blockedExpense.status);
const badKind = await call("/api/records", { method: "POST", token: sarah, body: { ops: [{ kind: "nope", id: "x", data: {} }] } });
check("unknown record type refused", badKind.status === 400);

const aideInvite = await call("/api/invites", { method: "POST", token: rosa, body: {} });
check("aide can't send invites", aideInvite.status === 403, aideInvite.status);
const mikeId = mikeState.data.me.id;
const familyRemove = await call(`/api/members/${mikeId}`, { method: "DELETE", token: jen });
check("non-organizer can't remove people", familyRemove.status === 403, familyRemove.status);

const link = await call("/api/me/device-link", { method: "POST", token: sarah, body: {} });
const second = await call(`/api/invites/${link.data.code}/join`, { method: "POST", body: {} });
check("organizer adds a second phone", second.status === 200 && second.data.memberId === created.data.memberId, JSON.stringify(second));
const reuse = await call(`/api/invites/${link.data.code}/join`, { method: "POST", body: {} });
check("phone link works only once", reuse.status === 410, reuse.status);

const removed = await call(`/api/members/${mikeId}`, { method: "DELETE", token: sarah });
check("organizer removes a member", removed.status === 200);
const mikeAfter = await call("/api/state", { token: mike });
check("removed member is signed out", mikeAfter.status === 401, mikeAfter.status);

const bad = await call("/api/stripe/webhook", { method: "POST", raw: "{}", headers: { "Stripe-Signature": "t=1,v1=00" } });
check("webhook rejects a bad signature", bad.status === 400, bad.status);

const circleId = created.data.circleId;
const event = JSON.stringify({
  id: `evt_${Date.now()}`,
  type: "customer.subscription.updated",
  data: { object: { id: "sub_test", customer: "cus_test", status: "trialing", metadata: { circle_id: circleId }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 14 * 86400 }] } } }
});
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", SECRET).update(`${t}.${event}`).digest("hex");
const hook = await call("/api/stripe/webhook", { method: "POST", raw: event, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
check("signed webhook accepted", hook.status === 200, JSON.stringify(hook));
const plusState = await call("/api/state", { token: sarah });
check("circle is on Plus after the webhook", plusState.data.circle.plan === "plus" && plusState.data.circle.planStatus === "trialing", JSON.stringify(plusState.data.circle));
const replay = await call("/api/stripe/webhook", { method: "POST", raw: event, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
check("duplicate webhook ignored", replay.data && replay.data.duplicate === true);
const okExpense = await call("/api/records", { method: "POST", token: sarah, body: { ops: [{ kind: "expense", id: "e1", data: { amt: 10, what: "Pharmacy", who: "x", at: Date.now() } }] } });
check("expenses allowed on Plus", okExpense.status === 200, okExpense.status);
const rosaState = await call("/api/state", { token: rosa });
check("aide doesn't see expenses", !rosaState.data.records.some((r) => r.kind === "expense"));

const page = await fetch(`${BASE}/j/${inv.data.code}`);
check("invite link loads the app page", page.status === 200 && (await page.text()).includes("Rally Care"));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
