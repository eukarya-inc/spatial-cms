FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and public
COPY src ./src
COPY public ./public

EXPOSE 3001

# Use tsx to run TypeScript directly (same as dev)
CMD ["npx", "tsx", "src/index.ts"]
