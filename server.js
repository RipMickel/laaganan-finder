const express = require("express");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.static(".")); // serve frontend

app.get("/weather", async (req, res) => {
  const { lat, lon } = req.query;

  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${process.env.WEATHER_API_KEY}&units=metric`;

  try {
    // Node 18+ has global fetch
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err); // log full error
    res.status(500).json({ error: "Failed to fetch weather" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});