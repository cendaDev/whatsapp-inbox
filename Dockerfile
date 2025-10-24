# Usa Debian (glibc) para evitar problemas de binarios
FROM node:20-bullseye-slim

WORKDIR /app

# Paquetes para compilar módulos nativos como better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 pkg-config libsqlite3-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copia solo package.json primero para aprovechar cache
COPY package.json ./

# Instala dependencias dentro del contenedor (NADA de node_modules del host)
RUN npm ci --omit=dev

# Copia el resto del proyecto (incluye /public y server.js, .env no es necesario copiar si usas env_file)
COPY . .

# Asegura carpeta de datos para SQLite
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["npm", "start"]
