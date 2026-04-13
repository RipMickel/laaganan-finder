let map = L.map('map').setView([14.5995, 120.9842], 10); // default Manila

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
}).addTo(map);

let markers = [];

// Try to center map on user's location on load
navigator.geolocation.getCurrentPosition(pos => {
  const { latitude, longitude } = pos.coords;
  map.setView([latitude, longitude], 11);
});

function generateGrid(lat, lon, step = 0.2, size = 2) {
  let points = [];
  for (let i = -size; i <= size; i++) {
    for (let j = -size; j <= size; j++) {
      points.push({
        lat: lat + i * step,
        lon: lon + j * step
      });
    }
  }
  return points;
}

async function fetchWeather(lat, lon) {
  const res = await fetch(`/weather?lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`);
  return res.json();
}

function scoreWeather(data, activity) {
  let score = 0;
  const temp = data.main.temp;
  const weather = data.weather[0].main;
  const wind = data.wind.speed;

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

    // Clear old markers
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    map.setView([latitude, longitude], 11);
    setResult("⏳ Fetching weather data for nearby spots...");

    const grid = generateGrid(latitude, longitude);

    // Fetch all points in parallel instead of sequentially
    const results = await Promise.allSettled(
      grid.map(async point => {
        const data = await fetchWeather(point.lat, point.lon);
        return { point, data };
      })
    );

    let bestSpot = null;
    let bestScore = -Infinity;

    for (const result of results) {
      if (result.status !== "fulfilled") continue;

      const { point, data } = result.value;
      const score = scoreWeather(data, activity);

      if (score > bestScore) {
        bestScore = score;
        bestSpot = { ...point, data, score };
      }

      const marker = L.circleMarker([point.lat, point.lon], {
        color: getColor(score),
        radius: 8
      })
        .addTo(map)
        .bindPopup(`
          Temp: ${data.main.temp}°C<br>
          Weather: ${data.weather[0].main}<br>
          Wind: ${data.wind.speed} m/s<br>
          Score: ${score}
        `);

      markers.push(marker);
    }

    if (bestSpot) {
      const d = bestSpot.data;
      L.marker([bestSpot.lat, bestSpot.lon])
        .addTo(map)
        .bindPopup(`
          <b>⭐ BEST SPOT</b><br>
          Temp: ${d.main.temp}°C<br>
          Weather: ${d.weather[0].main}<br>
          Score: ${bestSpot.score}
        `)
        .openPopup();

      setResult(`⭐ Best spot for <b>${activity}</b>: <b>${bestSpot.lat.toFixed(3)}, ${bestSpot.lon.toFixed(3)}</b> — ${d.weather[0].main}, ${d.main.temp}°C (score: ${bestSpot.score})`);
    } else {
      setResult("❌ Could not retrieve weather data. Check your API key.");
    }

  }, err => {
    setResult(`❌ Location error: ${err.message}. Please allow location access.`);
  });
}