FROM rust:1-bullseye AS subtitle-sync-builder
RUN cargo install alass-cli --version 2.0.0 --locked

FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python-is-python3 libgomp1 ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN python -m pip install --no-cache-dir pip==25.3 \
    && python -m pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY subtitle_sync.py .
COPY --from=subtitle-sync-builder /usr/local/cargo/bin/alass-cli /usr/local/bin/alass-cli
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
