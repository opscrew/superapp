FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=8080 METRICS_PORT=9464
EXPOSE 8080 9464
CMD ["node", "server.js"]
