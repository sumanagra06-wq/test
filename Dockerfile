# AetherBrackets bot — production image (Railway builds this automatically)
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# install dependencies first (cached between deploys)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# app code + bundled fonts
COPY . .

CMD ["node", "src/index.js"]
