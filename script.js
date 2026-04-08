const API_KEY = "YOUR_OPENWEATHER_API_KEY";

let map = L.map('map').setView([14.5995, 120.9842], 10); // default Manila

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
}).addTo(map);

let markers = [];

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
  const res = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`
  );
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
  }

  else if (activity === "hiking") {
    if (temp >= 18 && temp <= 26) score += 3;
    if (weather === "Clouds") score += 2;
    if (wind < 8) score += 1;
    if (weather === "Rain") score -= 4;
  }

  else {
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

async function loadData() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    const activity = document.getElementById("activity").value;

    const grid = generateGrid(latitude, longitude);

    let bestSpot = null;
    let bestScore = -Infinity;

    for (let point of grid) {
      try {
        const data = await fetchWeather(point.lat, point.lon);
        const score = scoreWeather(data, activity);

        if (score > bestScore) {
          bestScore = score;
          bestSpot = { ...point, data };
        }

        const marker = L.circleMarker([point.lat, point.lon], {
          color: getColor(score),
          radius: 8
        })
        .addTo(map)
        .bindPopup(`
          Temp: ${data.main.temp}°C <br>
          Weather: ${data.weather[0].main} <br>
          Score: ${score}
        `);

        markers.push(marker);

      } catch (err) {
        console.error(err);
      }
    }

    if (bestSpot) {
      L.marker([bestSpot.lat, bestSpot.lon])
        .addTo(map)
        .bindPopup("⭐ BEST LOCATION")
        .openPopup();
    }
  });
}