// Turn database rows into the exact JSON shapes the spec defines.

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSlot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start_raw, // echoed exactly as sent to /reset
    end: row.end_raw,
    available: row.available,
  };
}

module.exports = { toBooking, toSlot };
