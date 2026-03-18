# ---- build admin frontend (if present) ----
FROM node:22-alpine AS admin-build
WORKDIR /build
COPY . .
RUN if [ -d "admin-new" ]; then cd admin-new && npm ci && npm run build && cp -r dist ../public; \
    elif [ -d "admin" ]; then cd admin && npm ci && npm run build; \
    else mkdir -p public && echo '<!DOCTYPE html><html><body><h1>Admin UI not bundled</h1></body></html>' > public/index.html; fi

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
