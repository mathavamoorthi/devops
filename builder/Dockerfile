FROM node:20-alpine

RUN apk add --no-cache git docker-cli

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src ./src

CMD ["node", "src/index.js"]
