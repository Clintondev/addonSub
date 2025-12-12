FROM node:20-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV PORT=7000
EXPOSE 7000
CMD ["npm", "run", "start"]
