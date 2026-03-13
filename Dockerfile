FROM node:22-slim

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Non-root user for security
RUN useradd -m -u 1000 agent
USER agent

# Blueprints and knowledge repos mounted at runtime via K8s volumes
VOLUME ["/data/blueprints", "/data/sre-agent-knowledge"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
