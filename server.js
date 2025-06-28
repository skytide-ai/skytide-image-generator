const express = require('express');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

// Configuración desde variables de entorno
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Validar variables de entorno requeridas
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Error: Variables de entorno SUPABASE_URL y SUPABASE_SERVICE_KEY son requeridas');
  process.exit(1);
}

// Inicializar Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Inicializar Express
const app = express();

// Middleware de seguridad y optimización
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Variable global para reutilizar instancia de browser
let browserInstance = null;

// Función para obtener o crear instancia de browser
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log('🚀 Iniciando nueva instancia de Puppeteer...');
    
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--run-all-compositor-stages-before-draw',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off'
      ],
      defaultViewport: {
        width: 1200,
        height: 800,
        deviceScaleFactor: 2
      }
    });
    
    console.log('✅ Instancia de Puppeteer iniciada exitosamente');
  }
  
  return browserInstance;
}

// Función para generar imagen desde HTML
async function htmlToImage(htmlContent) {
  let page = null;
  
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    
    // Configurar viewport para imagen de alta calidad
    await page.setViewport({
      width: 1200,
      height: 800,
      deviceScaleFactor: 2
    });
    
    // Establecer el contenido HTML
    await page.setContent(htmlContent, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: 30000
    });
    
    // Esperar a que se carguen las fuentes y estilos
    await page.waitForTimeout(2000);
    
    // Tomar screenshot del elemento body completo
    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: true,
      quality: 100
    });
    
    return imageBuffer;
    
  } catch (error) {
    console.error('❌ Error generando imagen:', error);
    throw new Error(`Error en generación de imagen: ${error.message}`);
  } finally {
    if (page) {
      await page.close();
    }
  }
}

// Función para subir imagen a Supabase Storage
async function uploadImageToSupabase(imageBuffer, filename) {
  try {
    console.log(`📤 Subiendo imagen a Supabase Storage: ${filename}`);
    
    const { data, error } = await supabase.storage
      .from('agenda-images')
      .upload(filename, imageBuffer, {
        contentType: 'image/png',
        cacheControl: '3600',
        upsert: true
      });
    
    if (error) {
      console.error('❌ Error subiendo a Supabase Storage:', error);
      throw error;
    }
    
    // Obtener URL pública
    const { data: { publicUrl } } = supabase.storage
      .from('agenda-images')
      .getPublicUrl(filename);
    
    console.log(`✅ Imagen subida exitosamente: ${publicUrl}`);
    return publicUrl;
    
  } catch (error) {
    console.error('❌ Error en uploadImageToSupabase:', error);
    throw new Error(`Error subiendo imagen: ${error.message}`);
  }
}

// Endpoint principal para generar imagen
app.post('/generate-image', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('🖼️ Iniciando generación de imagen...');
    
    // Validar datos de entrada
    const { htmlContent, filename } = req.body;
    
    if (!htmlContent) {
      return res.status(400).json({
        success: false,
        error: 'htmlContent es requerido'
      });
    }
    
    if (!filename) {
      return res.status(400).json({
        success: false,
        error: 'filename es requerido'
      });
    }
    
    // Generar imagen desde HTML
    console.log('🎨 Renderizando HTML a imagen...');
    const imageBuffer = await htmlToImage(htmlContent);
    
    // Subir imagen a Supabase Storage
    console.log('☁️ Subiendo imagen a Supabase...');
    const imageUrl = await uploadImageToSupabase(imageBuffer, filename);
    
    const processingTime = Date.now() - startTime;
    console.log(`✅ Imagen generada exitosamente en ${processingTime}ms`);
    
    res.json({
      success: true,
      imageUrl,
      processingTime,
      message: 'Imagen generada y subida exitosamente'
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ Error generando imagen (${processingTime}ms):`, error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      processingTime
    });
  }
});

// Endpoint de health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    browserConnected: browserInstance?.isConnected() || false
  });
});

// Endpoint de información del servicio
app.get('/', (req, res) => {
  res.json({
    name: 'Skytide Image Generator',
    version: '1.0.0',
    description: 'Microservicio para generar imágenes de agenda a partir de HTML/CSS',
    endpoints: {
      'POST /generate-image': 'Generar imagen desde HTML',
      'GET /health': 'Estado del servicio',
      'GET /': 'Información del servicio'
    }
  });
});

// Manejo de errores globales
app.use((error, req, res, next) => {
  console.error('❌ Error no manejado:', error);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor'
  });
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint no encontrado'
  });
});

// Función de limpieza al cerrar el proceso
async function cleanup() {
  console.log('🧹 Cerrando recursos...');
  
  if (browserInstance) {
    try {
      await browserInstance.close();
      console.log('✅ Browser cerrado exitosamente');
    } catch (error) {
      console.error('❌ Error cerrando browser:', error);
    }
  }
  
  process.exit(0);
}

// Manejo de señales de cierre
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (error) => {
  console.error('❌ Excepción no capturada:', error);
  cleanup();
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
  cleanup();
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Skytide Image Generator iniciado en puerto ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🖼️ Endpoint principal: POST http://localhost:${PORT}/generate-image`);
}); 