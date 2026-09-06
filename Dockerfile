FROM golang:1.23-bookworm AS suptext-builder
RUN apt-get update && apt-get install -y --no-install-recommends libleptonica-dev libtesseract-dev && rm -rf /var/lib/apt/lists/*
RUN go install github.com/eliaonceagain/suptext@v0.2.2

FROM node:20-bookworm-slim
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tesseract-ocr tesseract-ocr-eng tesseract-ocr-por && rm -rf /var/lib/apt/lists/*
COPY --from=suptext-builder /go/bin/suptext /usr/local/bin/suptext
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=7000
EXPOSE 7000
CMD ["npm", "run", "start"]
