# Builds ONLY the bridge (a small FastAPI app). Hummingbot itself runs from
# its own official image in docker-compose.yml -- this repo does not build
# or vendor Hummingbot's source.
FROM python:3.11-slim
WORKDIR /app
COPY bridge/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bridge/ ./bridge/
EXPOSE 8090
CMD ["uvicorn", "bridge.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090"]
