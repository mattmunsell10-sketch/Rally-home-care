// Database schema. Every statement is idempotent, so the Worker runs them on
// first use and there is no separate migration step to remember on deploy.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS circles (
    id TEXT PRIMARY KEY,
    parent_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_status TEXT,
    plan_renews_at INTEGER,
    stripe_customer TEXT,
    stripe_subscription TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS members_circle ON members (circle_id)`,
  // One row per signed-in phone or browser. Only a hash of the token is kept.
  `CREATE TABLE IF NOT EXISTS devices (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS devices_member ON devices (member_id)`,
  // Join links. member_id is set for "add another phone" links.
  `CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    role TEXT NOT NULL,
    member_id TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`,
  // Everything a family shares (meds, doses, tasks, notes, expenses, shifts)
  // is a JSON record. Last write wins per record, which keeps sync simple.
  `CREATE TABLE IF NOT EXISTS records (
    circle_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (circle_id, kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS records_sync ON records (circle_id, updated_at)`,
  // Stripe sends some events more than once; this keeps handling idempotent.
  `CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  )`
];
