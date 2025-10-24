# Imagen base
FROM node:22-alpine

# Directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiamos package.json y package-lock.json
COPY package*.json ./

# Instalamos dependencias
RUN npm install --production

# Copiamos el resto del proyecto
COPY . .

# Expone el puerto del servidor
EXPOSE 3000

# Comando por defecto
CMD ["npm", "start"]
