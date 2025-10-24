# Node 20 en imagen ligera
FROM node:20-alpine

WORKDIR /app

# Instalar dependencias del sistema para better-sqlite3
RUN apk add --no-cache make g++ python3

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
