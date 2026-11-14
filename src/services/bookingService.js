const crypto = require("crypto");
const { pool } = require("../db");
const { HttpError, fail } = require("../lib/errors");
const { toBooking } = require("../lib/serializers");
const { checkRateLimit } = require("./rateLimit");
const { withIdempotency } = require("./idempotency");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Book one slot. Runs inside the request's transaction (`db`).
async function bookSlot(db, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};

  // Level 5: count the attempt first, so invalid attempts count too.
  if (typeof b.email === "string" && b.email.trim()) {
    await checkRateLimit(db, b.email.trim().toLowerCase());
  }

  // Level 2: required fields, valid email, slot exists and hasn't started.
  for (const field of ["slot_id", "name", "email"]) {
    if (typeof b[field] !== "string" || !b[field].trim()) {
      fail(400, `${field} is required`);
    }
  }
  const slotId = b.slot_id.trim();
  const name = b.name.trim();
  const email = b.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, "email is invalid");

  const slot = await db.query(
    "SELECT id, start_at <= now() AS started FROM slots WHERE id = $1",
    [slotId]
  );
  if (slot.rowCount === 0) fail(404, "Slot not found");
  if (slot.rows[0].started) fail(400, "This slot has already started");

  // Level 3: the database allows only one confirmed booking per slot (see the
  // unique index in db.js). If two requests race, Postgres accepts one and
  // rejects the other with error 23505, which becomes a 409. The savepoint
  // keeps the transaction usable after that rejection.
  await db.query("SAVEPOINT book");
  try {
    const { rows } = await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [crypto.randomUUID(), slotId, name, email]
    );
    await db.query("RELEASE SAVEPOINT book");
    return { status: 201, body: toBooking(rows[0]) };
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT book");
    if (err.code === "23505") fail(409, "This slot is already booked");
    throw err;
  }
}

// Return errors as results instead of throwing, so the transaction still
// commits: failed attempts must still count toward the rate limit.
async function tryBookSlot(db, body) {
  try {
    return await bookSlot(db, body);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, body: { error: err.message }, headers: err.headers };
  }
}

// Entry point for POST /bookings.
// Each request runs in ONE transaction on ONE connection, and every lock is
// transaction-scoped, so locks are released on COMMIT/ROLLBACK even behind
// Neon's connection pooler. If Postgres aborts the transaction with a
// deadlock, nothing was committed, so it is safe to retry.
async function createBooking({ body, idempotencyKey }) {
  for (let attemptNo = 1; ; attemptNo++) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result =
        idempotencyKey !== undefined
          ? await withIdempotency(db, idempotencyKey, body, () => tryBookSlot(db, body))
          : await tryBookSlot(db, body);
      await db.query("COMMIT");
      return result;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      if (["40P01", "40001"].includes(err.code) && attemptNo < 4) {
        await new Promise((r) => setTimeout(r, 25 * attemptNo + Math.random() * 50));
        continue;
      }
      throw err;
    } finally {
      db.release();
    }
  }
}

// Level 3: cancel a booking. Only a confirmed booking can be cancelled;
// cancelling takes it out of the unique index, which frees the slot.
async function cancelBooking(id) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING *`,
    [id]
  );
  if (rows.length) return toBooking(rows[0]);

  const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [id]);
  if (!exists.rowCount) fail(404, "Booking not found");
  fail(409, "Booking is already cancelled");
}

module.exports = { createBooking, cancelBooking };
