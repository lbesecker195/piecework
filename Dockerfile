FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=4020 DB_PATH=/data/piecework.db NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4020
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
