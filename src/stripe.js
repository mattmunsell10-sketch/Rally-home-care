// Stripe Billing over plain fetch, so the Worker needs no SDK.
// Uses Checkout for sign-up, the Billing portal for self-service changes,
// and webhooks as the single source of truth for a circle's plan.

const PLANS = {
  month: { amount: 699, interval: "month", env: "STRIPE_PRICE_MONTHLY" },
  year: { amount: 5900, interval: "year", env: "STRIPE_PRICE_YEARLY" }
};
const TRIAL_DAYS = 14;
const PLUS_STATUSES = new Set(["trialing", "active", "past_due"]);

function flatten(value, prefix, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}[${k}]` : k, out);
  } else {
    out.append(prefix, String(value));
  }
}

async function stripeRequest(env, method, path, params) {
  const body = new URLSearchParams();
  if (params) flatten(params, "", body);
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: method === "GET" ? undefined : body
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json && json.error && json.error.message ? json.error.message : `Stripe error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export function billingEnabled(env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export async function createCheckout(env, circle, origin, interval) {
  const plan = PLANS[interval] || PLANS.year;
  const priceId = env[plan.env];
  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: plan.amount,
          recurring: { interval: plan.interval },
          product_data: { name: "Rally Family Plus" }
        }
      };
  const params = {
    mode: "subscription",
    line_items: [lineItem],
    client_reference_id: circle.id,
    metadata: { circle_id: circle.id },
    subscription_data: { metadata: { circle_id: circle.id } },
    allow_promotion_codes: true,
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancelled`
  };
  // One free trial per circle.
  if (!circle.stripe_subscription) params.subscription_data.trial_period_days = TRIAL_DAYS;
  if (circle.stripe_customer) params.customer = circle.stripe_customer;
  const session = await stripeRequest(env, "POST", "checkout/sessions", params);
  return session.url;
}

export async function createPortal(env, circle, origin) {
  const session = await stripeRequest(env, "POST", "billing_portal/sessions", {
    customer: circle.stripe_customer,
    return_url: `${origin}/`
  });
  return session.url;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verifies the Stripe-Signature header as described in Stripe's webhook docs.
export async function verifyWebhook(payload, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t");
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  const ts = Number(t[1]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t[1]}.${payload}`)));
  return sigs.some((s) => safeEqual(s, mac));
}

async function applySubscription(env, sub) {
  const circleId = sub.metadata && sub.metadata.circle_id;
  const item = sub.items && sub.items.data && sub.items.data[0];
  const periodEnd = (item && item.current_period_end) || sub.current_period_end || null;
  const plan = PLUS_STATUSES.has(sub.status) ? "plus" : "free";
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id;
  await env.DB.prepare(
    `UPDATE circles SET plan = ?1, plan_status = ?2, plan_renews_at = ?3, stripe_customer = ?4, stripe_subscription = ?5
     WHERE id = ?6 OR stripe_subscription = ?5`
  )
    .bind(plan, sub.status, periodEnd ? periodEnd * 1000 : null, customer, sub.id, circleId || "")
    .run();
}

export async function handleWebhook(request, env) {
  const payload = await request.text();
  const ok = await verifyWebhook(payload, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("Invalid signature", { status: 400 });
  const event = JSON.parse(payload);

  const seen = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?1, ?2)")
    .bind(event.id, Date.now())
    .run();
  if (!seen.meta.changes) return Response.json({ received: true, duplicate: true });

  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode === "subscription" && obj.client_reference_id) {
        await env.DB.prepare("UPDATE circles SET stripe_customer = ?1, stripe_subscription = ?2 WHERE id = ?3")
          .bind(obj.customer, obj.subscription, obj.client_reference_id)
          .run();
        if (obj.subscription && billingEnabled(env)) {
          const sub = await stripeRequest(env, "GET", `subscriptions/${obj.subscription}`);
          await applySubscription(env, sub);
        }
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await applySubscription(env, obj);
      break;
    default:
      break;
  }
  return Response.json({ received: true });
}
