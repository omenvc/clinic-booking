// Settings read once at startup.
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY is not set");
}

module.exports = {
  API_KEY,
  RATE_LIMIT: 5, // booking attempts per email...
  RATE_WINDOW_SECONDS: 60, // ...per this many seconds
  PAGE_SIZE_DEFAULT: 10,
  PAGE_SIZE_MAX: 50,
};
