const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const isLocal = /localhost|127\.0\.0\.1|host=\/tmp/.test(connectionString);

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 10000,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,
  end_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The database itself guarantees a slot can have at most one confirmed booking,
-- so two simultaneous requests can never both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id    BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS booking_attempts_email_at ON booking_attempts (email, at);
`;

let ready = null;

// Create tables once per process. A transaction-scoped lock (released on
// COMMIT) stops two cold starts racing on CREATE TABLE. Transaction-scoped
// locks are used everywhere because Neon's pooler (PgBouncer, transaction
// mode) can run each statement outside a transaction on a different server
// connection, which breaks session-level locks.
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(7300001)");
        await client.query(SCHEMA);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = { pool, ensureSchema };
