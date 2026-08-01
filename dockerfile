FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create data directory for SQLite
RUN mkdir -p data

# Expose port (Railway needs this)
EXPOSE 3000

# Start the bot
CMD ["node", "src/index.js"]
