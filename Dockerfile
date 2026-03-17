# ---- build admin frontend ----
FROM node:22-alpine AS admin-build
WORKDIR /build/admin
COPY admin/package.json admin/package-lock.json* ./
RUN npm ci
COPY admin/ .
RUN npm run build
# vite outputs to /build/public (outDir: resolve(__dirname, "..", "public"))

# ---- production ----
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js .
COPY --from=admin-build /build/public ./public

ENV NODE_ENV=production
ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=19080

EXPOSE 19080

VOLUME ["/app/data"]

CMD ["node", "server.js"]
