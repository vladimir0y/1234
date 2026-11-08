# Production image: builds the web editor and serves it from the API.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app/server
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TUTU_DATA_DIR=/data
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app
COPY --from=web /web/dist /app/web/dist
RUN useradd --create-home tutu && mkdir -p /data && chown tutu /data
USER tutu
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
