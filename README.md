# 🖼️ Skytide Image Generator

Microservicio self-hosted para generar imágenes de agenda a partir de HTML/CSS usando Puppeteer. Diseñado para reemplazar la generación de imágenes en funciones de Netlify que tienen limitaciones de entorno.

## 📋 Características

- ✅ **Renderizado de alta calidad** con Puppeteer
- ✅ **Subida automática** a Supabase Storage
- ✅ **Arquitectura optimizada** para Docker/contenedores
- ✅ **Reutilización de instancia** de browser para mejor rendimiento
- ✅ **Health checks** y monitoreo integrado
- ✅ **Manejo robusto de errores** y cleanup automático
- ✅ **Seguridad** con middleware helmet y usuario no-root

## 🚀 Inicio Rápido

### Prerrequisitos

- Node.js 18+
- Cuenta de Supabase con Storage configurado
- Docker (para despliegue en producción)

### Instalación Local

1. **Clonar el repositorio**
```bash
git clone https://github.com/tu-usuario/skytide-image-generator.git
cd skytide-image-generator
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar variables de entorno**
```bash
cp env.example .env
# Editar .env con tus credenciales de Supabase
```

4. **Iniciar el servidor**
```bash
# Desarrollo
npm run dev

# Producción
npm start
```

El servidor estará disponible en `http://localhost:3000`

## 🐳 Despliegue con Docker

### Construcción local
```bash
docker build -t skytide-image-generator .
docker run -p 3000:3000 \
  -e SUPABASE_URL=tu_url \
  -e SUPABASE_SERVICE_KEY=tu_key \
  skytide-image-generator
```

### Despliegue en EasyPanel

1. **Conectar repositorio de GitHub** en EasyPanel
2. **Configurar variables de entorno:**
   ```env
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_SERVICE_KEY=tu_service_role_key
   PORT=3000
   NODE_ENV=production
   ```
3. **Usar el Dockerfile** incluido para el build automático

## 📡 API Endpoints

### `POST /generate-image`
Genera una imagen PNG a partir de HTML y la sube a Supabase Storage.

**Request Body:**
```json
{
  "htmlContent": "<html>...</html>",
  "filename": "agenda-2024-01-15.png"
}
```

**Response:**
```json
{
  "success": true,
  "imageUrl": "https://supabase.co/storage/v1/object/public/agenda-images/agenda-2024-01-15.png",
  "processingTime": 1250,
  "message": "Imagen generada y subida exitosamente"
}
```

### `GET /health`
Health check del servicio con métricas del sistema.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600,
  "memory": {...},
  "browserConnected": true
}
```

### `GET /`
Información general del servicio y endpoints disponibles.

## ⚙️ Configuración

### Variables de Entorno

| Variable | Descripción | Requerida | Valor por defecto |
|----------|-------------|-----------|-------------------|
| `PORT` | Puerto del servidor | No | `3000` |
| `SUPABASE_URL` | URL de tu proyecto Supabase | **Sí** | - |
| `SUPABASE_SERVICE_KEY` | Service Role Key de Supabase | **Sí** | - |
| `NODE_ENV` | Entorno de ejecución | No | `development` |

### Configuración de Supabase Storage

1. **Crear bucket `agenda-images`** en Supabase Storage
2. **Configurar políticas** de acceso público para lectura:
```sql
-- Política para permitir lectura pública
CREATE POLICY "Public read access" ON storage.objects
FOR SELECT USING (bucket_id = 'agenda-images');

-- Política para permitir subida con service key
CREATE POLICY "Service role upload" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'agenda-images');
```

## 🏗️ Arquitectura

```
┌─────────────────┐    POST /generate-image    ┌─────────────────┐
│                 │ ────────────────────────── │                 │
│ Función Netlify │                            │ Image Generator │
│                 │ ←────────────────────────── │   (Este repo)   │
└─────────────────┘     { imageUrl }           └─────────────────┘
                                                        │
                                                        │ Upload PNG
                                                        ▼
                                               ┌─────────────────┐
                                               │                 │
                                               │ Supabase Storage│
                                               │  agenda-images  │
                                               └─────────────────┘
```

## 🔧 Integración con Función de Netlify

Modifica tu función existente para usar el microservicio:

```javascript
// Reemplazar la función htmlToImage existente
async function generateAgendaImage(organization, memberGroups, date) {
  try {
    const htmlContent = generateAgendaHTML(organization, memberGroups, date);
    const filename = `agenda-${organization.id}-${date}-${Date.now()}.png`;
    
    const response = await fetch('https://tu-microservicio.com/generate-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        htmlContent,
        filename
      })
    });
    
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    return result.imageUrl;
    
  } catch (error) {
    console.error('Error generating image:', error);
    throw error;
  }
}
```

## 🛠️ Desarrollo

### Scripts disponibles
```bash
npm start      # Iniciar en producción
npm run dev    # Iniciar con nodemon para desarrollo
npm test       # Ejecutar tests (por implementar)
```

### Estructura del proyecto
```
skytide-image-generator/
├── server.js              # Servidor principal
├── package.json           # Dependencias y scripts
├── Dockerfile             # Configuración de contenedor
├── .gitignore            # Archivos ignorados por Git
├── env.example           # Ejemplo de variables de entorno
├── README.md             # Esta documentación
└── whatsapp-agenda-notifications.js  # Referencia (función original)
```

## 🔍 Troubleshooting

### Errores comunes

**Error: "Missing Supabase environment variables"**
- Verificar que `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` estén configuradas

**Error: "Failed to launch browser"**
- En Docker: Verificar que las dependencias de Chromium estén instaladas
- Localmente: Instalar Chromium/Chrome

**Error: "Storage bucket not found"**
- Crear el bucket `agenda-images` en Supabase Storage
- Verificar las políticas de acceso

### Logs y monitoreo

El servicio incluye logging detallado:
```bash
# Ver logs en tiempo real (Docker)
docker logs -f container-name

# Health check
curl http://localhost:3000/health
```

## 📄 Licencia

MIT License - ver archivo LICENSE para más detalles.

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Por favor:

1. Fork el proyecto
2. Crear una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abrir un Pull Request

## 📞 Soporte

Para soporte técnico o preguntas:
- Crear un [Issue](https://github.com/tu-usuario/skytide-image-generator/issues)
- Contactar: info@skytide.com 