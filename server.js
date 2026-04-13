const express = require("express");

const app = express();
const PORT = 3000;

app.use(express.static("."));

// WMO weather code → human-readable label
function interpretWMO(code) {
  if (code === 0) return "Clear";
  if (code <= 3) return "Clouds";
  if (code <= 48) return "Fog";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain";
  if (code <= 99) return "Thunderstorm";
  return "Unknown";
}

app.get("/weather", async (req, res) => {
  const { lat, lon } = req.query;

  // Open-Meteo: free, no API key needed
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,wind_speed_10m,weather_code` +
    `&wind_speed_unit=ms`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo error: ${response.status}`);
    const raw = await response.json();

    const c = raw.current;
    const weatherLabel = interpretWMO(c.weather_code);

    // Shape response to match what script.js already expects
    const data = {
      main: {
        temp: c.temperature_2m,
      },
      wind: {
        speed: c.wind_speed_10m,
      },
      weather: [
        {
          main: weatherLabel,
          code: c.weather_code,
        },
      ],
      name: "",
    };

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch weather" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});