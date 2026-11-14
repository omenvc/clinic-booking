const crypto = require("crypto");
const { API_KEY } = require("../config");

// Level 2: every request must send the right X-API-Key header, or it gets a 401.
// timingSafeEqual compares in constant time, so the key can't be guessed by timing.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireApiKey(req, res, next) {
  const key = req.get("X-API-Key");
  if (!key || !safeEqual(key, API_KEY)) {
    return res.status(401).json({ error: "Missing or invalid API key" });
  }
  next();
}

module.exports = requireApiKey;
