const express = require("express");
const requireApiKey = require("../middleware/requireApiKey");
const slotRoutes = require("./slots");
const bookingRoutes = require("./bookings");

// The API: every route sits behind the API key check.
const api = express.Router();
api.use(requireApiKey);
api.use("/", slotRoutes);
api.use("/bookings", bookingRoutes);

module.exports = api;
