# server.py — Python mein run karo: python server.py

import os
import numpy as np
import joblib
import tensorflow as tf
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

app = FastAPI()


# React dashboard ko allow karo
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ─── MODEL EK BAAR LOAD ────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

print("Model load ho raha hai...")
model    = tf.keras.models.load_model(
    os.path.join(BASE_DIR, "model", "weather_multistep_model.keras"),
    compile=False        # ← bas yeh add karo — Keras version mismatch fix
)
scaler_X = joblib.load(
    os.path.join(BASE_DIR, "model", "scaler_X.pkl"))
scaler_y = joblib.load(
    os.path.join(BASE_DIR, "model", "scaler_y.pkl"))
print("Model ready!")

FEATURES     = ["temperature","humidity","wind_speed",
                "cloud_cover","precipitation","pressure","solar_rad"]
SEQ_LEN      = 24
PRED_HORIZON = 6
SOLAR_SHARE  = 0.55
WIND_SHARE   = 0.45
Z_THRESH     = 3.0


# ─── REQUEST FORMAT ────────────────────────────────────────
class WeatherRow(BaseModel):
    temperature:   float
    humidity:      float
    wind_speed:    float
    cloud_cover:   float
    precipitation: float
    pressure:      float
    solar_rad:     float

class PredictRequest(BaseModel):
    last_24h: List[WeatherRow]
    green_mw: float = 150.0
    beta:     float = 1.0


# ─── LIVE WEATHER ENDPOINT ─────────────────────────────────
# Uses Open-Meteo API — completely free, no API key needed
@app.get("/live-weather")
def get_live_weather(lat: float = 28.6, lon: float = 77.2):
    """
    Fetches last 24 hours of real weather data from Open-Meteo.
    Default location: New Delhi (change lat/lon for your city)
    Frontend calls this to auto-fill weather inputs.
    """
    try:
        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude":        lat,
            "longitude":       lon,
            "hourly": [
                "temperature_2m",
                "relative_humidity_2m",
                "wind_speed_10m",
                "cloud_cover",
                "precipitation",
                "surface_pressure",
                "shortwave_radiation"
            ],
            "past_days":    1,   # get yesterday + today
            "forecast_days": 0,
            "timezone":     "auto"
        }

        r = response = requests.get(url, params=params, timeout=10)
        r.raise_for_status()
        data = r.json()["hourly"]

        # Take last 24 rows
        rows = []
        n = len(data["temperature_2m"])
        start = max(0, n - 24)

        for i in range(start, n):
            rows.append({
                "temperature":   round(float(data["temperature_2m"][i] or 25), 2),
                "humidity":      round(float(data["relative_humidity_2m"][i] or 60), 2),
                "wind_speed":    round(float(data["wind_speed_10m"][i] or 10), 2),
                "cloud_cover":   round(float(data["cloud_cover"][i] or 30), 2),
                "precipitation": round(float(data["precipitation"][i] or 0), 2),
                "pressure":      round(float(data["surface_pressure"][i] or 1013), 2),
                "solar_rad":     round(float(data["shortwave_radiation"][i] or 200), 2),
            })

        # Latest reading for display in dashboard
        latest = rows[-1] if rows else {}

        return {
            "success":    True,
            "location":   {"lat": lat, "lon": lon},
            "last_24h":   rows,
            "latest":     latest,
            "rows_count": len(rows)
        }

    except requests.exceptions.ConnectionError:
        return {"success": False, "error": "Cannot reach Open-Meteo API. Check internet connection."}
    except requests.exceptions.Timeout:
        return {"success": False, "error": "Open-Meteo API timeout. Try again."}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─── PREDICTION ENDPOINT ───────────────────────────────────
@app.post("/predict")
def predict(req: PredictRequest):

    if len(req.last_24h) != 24:
        return {"error": "Exactly 24 rows required"}

    # 1. Input array banao
    X_raw = np.array([[
        r.temperature, r.humidity, r.wind_speed,
        r.cloud_cover, r.precipitation, r.pressure, r.solar_rad
    ] for r in req.last_24h])                           # (24, 7)

    # 2. Z-score sensor check
    mean = X_raw.mean(axis=0)
    std  = X_raw.std(axis=0) + 1e-9
    sensor_correction = 0.0
    sensor_status = []

    for i, row in enumerate(X_raw):
        z_scores = np.abs((row - mean) / std)
        faulty_cols = np.where(z_scores > Z_THRESH)[0]
        if len(faulty_cols) > 0:
            for col in faulty_cols:
                diff = row[col] - mean[col]
                sensor_correction += -diff * 0.1
            sensor_status.append({
                "row":    i,
                "z_max":  round(float(z_scores.max()), 2),
                "faulty": True
            })

    # 3. Scaling
    X_scaled = scaler_X.transform(X_raw)
    X_input  = X_scaled.reshape(1, SEQ_LEN, len(FEATURES))

    # 4. Prediction
    pred_sc  = model.predict(X_input, verbose=0)[0]
    pred_inv = scaler_y.inverse_transform(pred_sc)
    print("RAW MODEL OUTPUT:", pred_inv)

    # 5. Response banao
    forecast = []
    storm_eta = None
    STORM_THRESHOLD = 0.5 + 0.1 * req.beta

    for h in range(PRED_HORIZON):
        # ✅ Fixed: use pred_inv (not pred)
        sp = float(np.clip(pred_inv[h, 0], 0, 1))
        sd = float(np.clip(pred_inv[h, 1], 0, 100))
        wd = float(np.clip(pred_inv[h, 2], 0, 100))

        sp = float(np.nan_to_num(sp))
        sd = float(np.nan_to_num(sd))
        wd = float(np.nan_to_num(wd))

        # Wind shutdown (storm condition)
        if X_raw[-1][2] > 25:
            wd = 100

        # Night condition (no solar)
        if X_raw[-1][6] < 10:
            sd = 100

        # ✅ Fixed: correct deficit formula
        raw_deficit = req.green_mw - (
            req.green_mw * SOLAR_SHARE * (1 - sd / 100) +
            req.green_mw * WIND_SHARE  * (1 - wd / 100)
        )
        adj_deficit = max(0, raw_deficit + sensor_correction)
        is_storm    = sp >= STORM_THRESHOLD

        if is_storm and storm_eta is None:
            storm_eta = h + 1

        forecast.append({
            "hour":        h + 1,
            "storm_prob":  round(sp * 100, 1),
            "solar_drop":  round(sd, 1),
            "wind_drop":   round(wd, 1),
            "raw_deficit": round(raw_deficit, 1),
            "adj_deficit": round(adj_deficit, 1),
            "is_storm":    is_storm
        })

    return {
        "forecast":          forecast,
        "storm_eta_hours":   storm_eta,
        "sensor_correction": round(sensor_correction, 2),
        "sensor_issues":     sensor_status
    }
@app.get("/")
def root():
    return {"status": "AI Dispatcher running", "model": "ready"}

# ─── RUN SERVER ─────────────────────────────────────────
if __name__ == "__main__":
    import os
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)