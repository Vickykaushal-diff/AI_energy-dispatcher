# ⚡ AI Energy Dispatcher

AI-powered energy dispatch system using LSTM weather forecasting.

## Tech Stack
- React 18 (Frontend)
- FastAPI + Python (Backend)
- TensorFlow LSTM (AI Model)
- Open-Meteo API (Live Weather)

## Features
- 6-hour storm probability forecast
- Live weather auto-fetch
- Sensor Z-score anomaly detection
- Greedy loss minimization
- ESG PDF report export

## Run Locally

### Backend
cd backend
pip install -r requirement.txt
python server.py

### Frontend
cd frontend
npm install
npm start

## Note
Model files (.keras, .pkl) not included due to size.