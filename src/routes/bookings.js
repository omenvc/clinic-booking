const express = require("express");
const { pool } = require("../db");
const { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } = require("../config");
const { fail } = require("../lib/errors");
const { toBooking } = require("../lib/serializers");
const { encodeCursor, decodeCursor } = require("../lib/cursor");
const { createBooking, cancelBooking } = require("../services/bookingService");

const router = express.Router();

// POST /bookings (levels 1-5): book a slot. All the rules live in bookingService.
router.post("/", async (req, res) => {
  const idempotencyKey = req.get("Idempotency-Key");
  if (idempotencyKey !== undefined && !idempotencyKey.trim()) {
    fail(400, "Idempotency-Key must not be empty");
  }

  const result = await createBooking({ body: req.body, idempotencyKey });
  if (result.headers) res.set(result.headers);
  res.status(result.status).json(result.body);
});

// GET /bookings?email=&limit=&cursor= (level 4): a person's bookings, oldest
// first, one page at a time. Email matching ignores case.
router.get("/", async (req, res) => {
  const { email, limit, cursor } = req.query;
  if (typeof email !== "string" || !email.trim()) fail(400, "email is required");

  let pageSize = PAGE_SIZE_DEFAULT;
  if (limit !== undefined) {
    const invalid = `limit must be an integer from 1 to ${PAGE_SIZE_MAX}`;
    if (typeof limit !== "string" || !/^\d+$/.test(limit)) fail(400, invalid);
    pageSize = Number(limit);
    if (pageSize < 1 || pageSize > PAGE_SIZE_MAX) fail(400, invalid);
  }

  let after = "0";
  if (cursor !== undefined && cursor !== "") {
    if (typeof cursor !== "string") fail(400, "cursor is invalid");
    after = decodeCursor(cursor);
  }

  // Fetch one extra row to know whether there is a next page.
  const { rows } = await pool.query(
    `SELECT * FROM bookings
      WHERE email = lower(trim($1)) AND seq > $2
      ORDER BY seq
      LIMIT $3`,
    [email, after, pageSize + 1]
  );
  const page = rows.slice(0, pageSize);
  const nextCursor = rows.length > pageSize ? encodeCursor(page[page.length - 1].seq) : null;
  res.json({ bookings: page.map(toBooking), next_cursor: nextCursor });
});

// GET /bookings/:id (level 1): one booking, or 404.
router.get("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
  if (!rows.length) fail(404, "Booking not found");
  res.json(toBooking(rows[0]));
});

// DELETE /bookings/:id (level 3): cancel and free the slot.
router.delete("/:id", async (req, res) => {
  res.json(await cancelBooking(req.params.id));
});

module.exports = router;
