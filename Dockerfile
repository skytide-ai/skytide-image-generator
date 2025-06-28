# Usar imagen oficial de Node.js con Alpine Linux para menor tamaño
FROM node:18-alpine

# Información del mantenedor
LABEL maintainer="Skytide <info@skytide.com>"
LABEL description="Microservicio para generar imágenes de agenda usando Puppeteer"

# Instalar dependencias del sistema necesarias para Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ttf-dejavu \
    ttf-droid \
    ttf-liberation \
    font-noto \
    font-noto-emoji

# Configurar Puppeteer para usar Chromium instalado del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Crear directorio de la aplicación
WORKDIR /app

# Crear usuario no-root para seguridad
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de Node.js
RUN npm ci --only=production && \
    npm cache clean --force

# Copiar código fuente
COPY --chown=nextjs:nodejs . .

# Cambiar al usuario no-root
USER nextjs

# Exponer puerto
EXPOSE 3000

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { \
        if (res.statusCode === 200) process.exit(0); \
        else process.exit(1); \
    }).on('error', () => process.exit(1));"

# Comando para iniciar la aplicación
CMD ["node", "server.js"] 