FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python-is-python3 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
