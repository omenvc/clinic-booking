const express = require("express");
const { pool } = require("../db");
const { fail } = require("../lib/errors");
const { toSlot } = require("../lib/serializers");

const router = express.Router();

// POST /reset (level 1): delete every booking and replace all slots.
router.post("/reset", async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) fail(400, "slots must be an array");

  const seen = new Set();
  slots.forEach((s, i) => {
    if (!s || typeof s !== "object") fail(400, `slots[${i}] is invalid`);
    for (const f of ["id", "provider", "start", "end"]) {
      if (typeof s[f] !== "string" || !s[f].trim()) fail(400, `slots[${i}].${f} is required`);
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      fail(400, `slots[${i}] has an invalid date`);
    }
    if (seen.has(s.id)) fail(400, `Duplicate slot id: ${s.id}`);
    seen.add(s.id);
  });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM bookings");
    await db.query("DELETE FROM idempotency_keys");
    await db.query("DELETE FROM booking_attempts");
    await db.query("DELETE FROM slots");
    if (slots.length) {
      await db.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])`,
        [
          slots.map((s) => s.id),
          slots.map((s) => s.provider),
          slots.map((s) => s.start),
          slots.map((s) => s.end),
          slots.map((s) => new Date(s.start).toISOString()),
          slots.map((s) => new Date(s.end).toISOString()),
        ]
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  res.status(200).json({ status: "ok", slots: slots.length });
});

// GET /slots (level 1): all slots by start time, with whether each is free.
// Optional ?provider= filter (exact match).
router.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.*,
            NOT EXISTS (SELECT 1 FROM bookings b
                         WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider]
  );
  res.json({ slots: rows.map(toSlot) });
});

module.exports = router;
