let map = L.map('map').setView([14.5995, 120.9842], 10);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
}).addTo(map);

let markers = [];

navigator.geolocation.getCurrentPosition(pos => {
  map.setView([pos.coords.latitude, pos.coords.longitude], 11);
});

function generateGrid(lat, lon, step = 0.2, size = 2) {
  let points = [];
  for (let i = -size; i <= size; i++) {
    for (let j = -size; j <= size; j++) {
      points.push({ lat: lat + i * step, lon: lon + j * step });
    }
  }
  return points;
}

// WMO weather code → label
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

async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,wind_speed_10m,weather_code` +
    `&wind_speed_unit=ms`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const raw = await res.json();
  const c = raw.current;

  return {
    temp: c.temperature_2m,
    wind: c.wind_speed_10m,
    weather: interpretWMO(c.weather_code),
  };
}

async function getPlaceName(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { "Accept-Language": "en" } }
    );
    const data = await res.json();
    // Prefer suburb/village/town/city — whatever is most specific
    const a = data.address;
    return a.suburb || a.village || a.town || a.city || a.county || data.display_name.split(",")[0];
  } catch {
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}

function scoreWeather(temp, weather, wind, activity) {
  let score = 0;

  if (activity === "beach") {
    if (temp >= 26 && temp <= 34) score += 3;
    if (weather === "Clear") score += 3;
    if (wind < 6) score += 1;
    if (weather === "Rain") score -= 5;
  } else if (activity === "hiking") {
    if (temp >= 18 && temp <= 26) score += 3;
    if (weather === "Clouds") score += 2;
    if (wind < 8) score += 1;
    if (weather === "Rain") score -= 4;
  } else {
    if (temp >= 20 && temp <= 30) score += 2;
    if (weather === "Clear") score += 2;
    if (weather === "Rain") score -= 3;
  }

  return score;
}

function getColor(score) {
  if (score >= 5) return "green";
  if (score >= 2) return "orange";
  return "red";
}

function setResult(msg) {
  document.getElementById("result").innerHTML = msg;
}

async function loadData() {
  setResult("📍 Getting your location...");

  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    const activity = document.getElementById("activity").value;

    markers.forEach(m => map.removeLayer(m));
    markers = [];
    map.setView([latitude, longitude], 11);
    setResult("⏳ Fetching weather for nearby spots...");

    const grid = generateGrid(latitude, longitude);

    const results = await Promise.allSettled(
      grid.map(async point => {
        const w = await fetchWeather(point.lat, point.lon);
        return { point, w };
      })
    );

    const succeeded = results.filter(r => r.status === "fulfilled");

    if (succeeded.length === 0) {
      const reason = results[0]?.reason?.message || "Unknown error";
      setResult(`❌ Failed to fetch weather: <b>${reason}</b>`);
      return;
    }

    let bestSpot = null;
    let bestScore = -Infinity;

    for (const result of succeeded) {
      const { point, w } = result.value;
      const score = scoreWeather(w.temp, w.weather, w.wind, activity);

      if (score > bestScore) {
        bestScore = score;
        bestSpot = { ...point, w, score };
      }

      const marker = L.circleMarker([point.lat, point.lon], {
        color: getColor(score),
        radius: 8,
      })
        .addTo(map)
        .bindPopup(`
          Temp: ${w.temp}°C<br>
          Weather: ${w.weather}<br>
          Wind: ${w.wind} m/s<br>
          Score: ${score}
        `);

      markers.push(marker);
    }

    if (bestSpot) {
      setResult("📍 Finding place name...");

      const placeName = await getPlaceName(bestSpot.lat, bestSpot.lon);

      L.marker([bestSpot.lat, bestSpot.lon])
        .addTo(map)
        .bindPopup(`
          <b>⭐ BEST SPOT</b><br>
          <b>${placeName}</b><br>
          Temp: ${bestSpot.w.temp}°C<br>
          Weather: ${bestSpot.w.weather}<br>
          Score: ${bestSpot.score}
        `)
        .openPopup();

      setResult(`⭐ Best spot for <b>${activity}</b>: <b>${placeName}</b> — ${bestSpot.w.weather}, ${bestSpot.w.temp}°C (score: ${bestSpot.score})`);
    }

  }, err => {
    setResult(`❌ Location error: ${err.message}. Please allow location access.`);
  });
}