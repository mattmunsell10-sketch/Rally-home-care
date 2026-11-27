import { SCHEMA } from "./schema.js";
import { billingEnabled, createCheckout, createPortal, handleWebhook } from "./stripe.js";

const KINDS = new Set(["med", "dose", "task", "log", "expense", "shift"]);
const PLUS_KINDS = new Set(["expense"]);
const ROLES = new Set(["Organizer", "Family", "Aide"]);
const COLORS = ["#1F5E5B", "#C2662D", "#5B4FA8", "#2F7FA8", "#8A5A2B", "#A33F6B", "#3E7D3A", "#9A3B3B"];
const INVITE_TTL = 7 * 24 * 3600e3;
const DEVICE_LINK_TTL = 15 * 60e3;
const MAX_OPS = 200;
const MAX_RECORD_BYTES = 8 * 1024;

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

function randomId(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Short, unambiguous codes for links people send by text.
function inviteCode(len = 10) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const a = crypto.getRandomValues(new Uint8Array(len));
  return [...a].map((b) => alphabet[b % alphabet.length]).join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Send a JSON body.");
  }
}

async function issueDevice(env, memberId) {
  const token = randomId(32);
  await env.DB.prepare("INSERT INTO devices (token_hash, member_id, created_at, last_seen) VALUES (?1, ?2, ?3, ?3)")
    .bind(await sha256(token), memberId, Date.now())
    .run();
  return token;
}

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Sign in again from your invite link.");
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.name, m.role, m.color, c.*
     FROM devices d JOIN members m ON m.id = d.member_id JOIN circles c ON c.id = m.circle_id
     WHERE d.token_hash = ?1 AND m.removed = 0`
  )
    .bind(hash)
    .first();
  if (!row) throw new HttpError(401, "This phone is no longer part of the care circle.");
  // Touch last_seen at most once an hour to keep writes low.
  env.DB.prepare("UPDATE devices SET last_seen = ?1 WHERE token_hash = ?2 AND (last_seen IS NULL OR last_seen < ?3)")
    .bind(Date.now(), hash, Date.now() - 3600e3)
    .run()
    .catch(() => {});
  return {
    member: { id: row.member_id, name: row.name, role: row.role, color: row.color },
    circle: row
  };
}

function publicCircle(c) {
  return { id: c.id, parentName: c.parent_name, plan: c.plan, planStatus: c.plan_status, planRenewsAt: c.plan_renews_at, hasBilling: Boolean(c.stripe_customer) };
}

function requireRole(member, ...roles) {
  if (!roles.includes(member.role)) throw new HttpError(403, "Only the organizer can do that.");
}

function canSeeKind(member, kind) {
  return !(member.role === "Aide" && kind === "expense");
}

async function nextColor(env, circleId) {
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM members WHERE circle_id = ?1").bind(circleId).first();
  return COLORS[count % COLORS.length];
}

// --- Route handlers ---------------------------------------------------------

async function createCircle(request, env) {
  const b = await body(request);
  const parentName = cleanText(b.parentName, 40);
  const yourName = cleanText(b.yourName, 40);
  if (!parentName || !yourName) throw new HttpError(400, "Add who you are caring for and your first name.");
  const now = Date.now();
  const circleId = randomId(12);
  const memberId = randomId(8);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO circles (id, parent_name, created_at) VALUES (?1, ?2, ?3)").bind(circleId, parentName, now),
    env.DB.prepare("INSERT INTO members (id, circle_id, name, role, color, created_at) VALUES (?1, ?2, ?3, 'Organizer', ?4, ?5)").bind(memberId, circleId, yourName, COLORS[0], now)
  ]);
  const token = await issueDevice(env, memberId);
  return json({ token, circleId, memberId }, 201);
}

async function getState(request, env, auth) {
  const url = new URL(request.url);
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const now = Date.now();
  const [members, records] = await Promise.all([
    env.DB.prepare("SELECT id, name, role, color FROM members WHERE circle_id = ?1 AND removed = 0 ORDER BY created_at").bind(auth.circle.id).all(),
    // A two second overlap covers writes that landed while this read ran.
    env.DB.prepare("SELECT kind, id, data, updated_at, updated_by, deleted FROM records WHERE circle_id = ?1 AND updated_at > ?2 ORDER BY updated_at")
      .bind(auth.circle.id, since ? since - 2000 : 0)
      .all()
  ]);
  return json({
    now,
    full: !since,
    circle: publicCircle(auth.circle),
    me: auth.member,
    members: members.results,
    records: records.results
      .filter((r) => canSeeKind(auth.member, r.kind))
      .map((r) => ({ kind: r.kind, id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: Boolean(r.deleted) })),
    billingEnabled: billingEnabled(env)
  });
}

async function putRecords(request, env, auth) {
  const b = await body(request);
  const ops = Array.isArray(b.ops) ? b.ops : [];
  if (!ops.length) return json({ saved: 0 });
  if (ops.length > MAX_OPS) throw new HttpError(413, `Send at most ${MAX_OPS} changes at a time.`);
  const now = Date.now();
  const stmts = [];
  for (const op of ops) {
    const kind = String(op.kind || "");
    const id = String(op.id || "").slice(0, 80);
    if (!KINDS.has(kind) || !id) throw new HttpError(400, "Unknown record type.");
    if (!canSeeKind(auth.member, kind)) throw new HttpError(403, "Aides can't change family expenses.");
    if (PLUS_KINDS.has(kind) && auth.circle.plan !== "plus") throw new HttpError(402, "Shared expenses are part of Family Plus.");
    const data = JSON.stringify(op.data ?? {});
    if (data.length > MAX_RECORD_BYTES) throw new HttpError(413, "That entry is too long.");
    stmts.push(
      env.DB.prepare(
        `INSERT INTO records (circle_id, kind, id, data, updated_at, updated_by, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (circle_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted`
      ).bind(auth.circle.id, kind, id, data, now, auth.member.id, op.deleted ? 1 : 0)
    );
  }
  await env.DB.batch(stmts);
  return json({ saved: stmts.length, now });
}

async function createInvite(request, env, auth) {
  requireRole(auth.member, "Organizer", "Family");
  const b = await body(request).catch(() => ({}));
  const role = b.role === "Aide" ? "Aide" : "Family";
  const code = inviteCode();
  const expiresAt = Date.now() + INVITE_TTL;
  await env.DB.prepare("INSERT INTO invites (code, circle_id, created_by, role, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(code, auth.circle.id, auth.member.id, role, expiresAt)
    .run();
  return json({ code, role, expiresAt }, 201);
}

async function createDeviceLink(request, env, auth) {
  const code = inviteCode(12);
  const expiresAt = Date.now() + DEVICE_LINK_TTL;
  await env.DB.prepare("INSERT INTO invites (code, circle_id, created_by, role, member_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?3, ?5)")
    .bind(code, auth.circle.id, auth.member.id, auth.member.role, expiresAt)
    .run();
  return json({ code, expiresAt }, 201);
}

async function loadInvite(env, code) {
  const inv = await env.DB.prepare(
    `SELECT i.*, c.parent_name, m.name AS inviter FROM invites i
     JOIN circles c ON c.id = i.circle_id JOIN members m ON m.id = i.created_by
     WHERE i.code = ?1`
  )
    .bind(code)
    .first();
  if (!inv) throw new HttpError(404, "This invite link doesn't work. Ask for a new one.");
  if (inv.expires_at < Date.now() || (inv.member_id && inv.used_at)) throw new HttpError(410, "This invite link has expired. Ask for a new one.");
  return inv;
}

async function getInvite(env, code) {
  const inv = await loadInvite(env, code);
  return json({ parentName: inv.parent_name, invitedBy: inv.inviter, role: inv.role, kind: inv.member_id ? "device" : "join" });
}

async function acceptInvite(request, env, code) {
  const inv = await loadInvite(env, code);
  if (inv.member_id) {
    const used = await env.DB.prepare("UPDATE invites SET used_at = ?1 WHERE code = ?2 AND used_at IS NULL").bind(Date.now(), code).run();
    if (!used.meta.changes) throw new HttpError(410, "This link was already used.");
    const token = await issueDevice(env, inv.member_id);
    return json({ token, circleId: inv.circle_id, memberId: inv.member_id });
  }
  const b = await body(request);
  const name = cleanText(b.name, 40);
  if (!name) throw new HttpError(400, "Add your first name.");
  const memberId = randomId(8);
  await env.DB.prepare("INSERT INTO members (id, circle_id, name, role, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(memberId, inv.circle_id, name, ROLES.has(inv.role) ? inv.role : "Family", await nextColor(env, inv.circle_id), Date.now())
    .run();
  const token = await issueDevice(env, memberId);
  return json({ token, circleId: inv.circle_id, memberId }, 201);
}

async function updateMe(request, env, auth) {
  const b = await body(request);
  const name = cleanText(b.name, 40);
  if (!name) throw new HttpError(400, "Add your first name.");
  await env.DB.prepare("UPDATE members SET name = ?1 WHERE id = ?2").bind(name, auth.member.id).run();
  return json({ ok: true });
}

async function leave(env, auth) {
  await env.DB.prepare("DELETE FROM devices WHERE member_id = ?1").bind(auth.member.id).run();
  return json({ ok: true });
}

async function updateMember(request, env, auth, memberId) {
  requireRole(auth.member, "Organizer");
  const b = await body(request);
  if (!ROLES.has(b.role)) throw new HttpError(400, "Pick Organizer, Family or Aide.");
  const res = await env.DB.prepare("UPDATE members SET role = ?1 WHERE id = ?2 AND circle_id = ?3 AND removed = 0").bind(b.role, memberId, auth.circle.id).run();
  if (!res.meta.changes) throw new HttpError(404, "That person isn't in this circle.");
  return json({ ok: true });
}

async function removeMember(env, auth, memberId) {
  requireRole(auth.member, "Organizer");
  if (memberId === auth.member.id) throw new HttpError(400, "You can't remove yourself. Make someone else organizer first.");
  const res = await env.DB.prepare("UPDATE members SET removed = 1 WHERE id = ?1 AND circle_id = ?2").bind(memberId, auth.circle.id).run();
  if (!res.meta.changes) throw new HttpError(404, "That person isn't in this circle.");
  await env.DB.prepare("DELETE FROM devices WHERE member_id = ?1").bind(memberId).run();
  return json({ ok: true });
}

async function updateCircle(request, env, auth) {
  requireRole(auth.member, "Organizer");
  const b = await body(request);
  const parentName = cleanText(b.parentName, 40);
  if (!parentName) throw new HttpError(400, "Add a name.");
  await env.DB.prepare("UPDATE circles SET parent_name = ?1 WHERE id = ?2").bind(parentName, auth.circle.id).run();
  return json({ ok: true });
}

async function checkout(request, env, auth) {
  requireRole(auth.member, "Organizer");
  if (!billingEnabled(env)) throw new HttpError(503, "Payments aren't switched on yet.");
  const b = await body(request).catch(() => ({}));
  const url = await createCheckout(env, auth.circle, new URL(request.url).origin, b.interval === "month" ? "month" : "year");
  return json({ url });
}

async function portal(request, env, auth) {
  requireRole(auth.member, "Organizer");
  if (!billingEnabled(env) || !auth.circle.stripe_customer) throw new HttpError(400, "There's no subscription to manage yet.");
  return json({ url: await createPortal(env, auth.circle, new URL(request.url).origin) });
}

// --- Router -----------------------------------------------------------------

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = request.method;
  await ensureSchema(env);

  if (path === "/api/health") return json({ ok: true });
  if (path === "/api/stripe/webhook" && m === "POST") return handleWebhook(request, env);
  if (path === "/api/circles" && m === "POST") return createCircle(request, env);

  let match = path.match(/^\/api\/invites\/([a-z0-9]{6,16})(\/join)?$/);
  if (match) {
    if (m === "GET" && !match[2]) return getInvite(env, match[1]);
    if (m === "POST" && match[2]) return acceptInvite(request, env, match[1]);
  }

  const auth = await authenticate(request, env);
  if (path === "/api/state" && m === "GET") return getState(request, env, auth);
  if (path === "/api/records" && m === "POST") return putRecords(request, env, auth);
  if (path === "/api/invites" && m === "POST") return createInvite(request, env, auth);
  if (path === "/api/me/device-link" && m === "POST") return createDeviceLink(request, env, auth);
  if (path === "/api/me" && m === "PATCH") return updateMe(request, env, auth);
  if (path === "/api/me/leave" && m === "POST") return leave(env, auth);
  if (path === "/api/circle" && m === "PATCH") return updateCircle(request, env, auth);
  if (path === "/api/billing/checkout" && m === "POST") return checkout(request, env, auth);
  if (path === "/api/billing/portal" && m === "POST") return portal(request, env, auth);
  match = path.match(/^\/api\/members\/([a-f0-9]{16})$/);
  if (match && m === "PATCH") return updateMember(request, env, auth, match[1]);
  if (match && m === "DELETE") return removeMember(env, auth, match[1]);
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        return json({ error: "Something went wrong on our side. Try again in a minute." }, 500);
      }
    }
    // Everything else is the app itself; /j/<code> links load the same page.
    return env.ASSETS.fetch(request);
  }
};
