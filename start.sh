#!/bin/bash
set -e

echo "==> Avvio backend FastAPI su porta 8000..."
cd backend
uvicorn server:app --host localhost --port 8000 &
BACKEND_PID=$!
cd ..

echo "==> Avvio proxy su porta 5000..."
node proxy.js &
PROXY_PID=$!

echo "==> Avvio Expo web su porta 8081..."
cd frontend
export EXPO_PUBLIC_BACKEND_URL=""
npx expo start --web --port 8081

trap "echo 'Shutdown...'; kill $BACKEND_PID $PROXY_PID 2>/dev/null; exit 0" EXIT INT TERM
