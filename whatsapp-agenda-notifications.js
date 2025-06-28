const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

exports.handler = async (event, context) => {
  console.log('🚀 WhatsApp Agenda Notifications - Starting execution');
  
  try {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    console.log(`⏰ Current time: ${currentHour}:${currentMinute.toString().padStart(2, '0')}`);
    
    // MODO TESTING: Ejecutar cada 10 minutos (comentar cuando esté en producción)
    // Solo ejecutar en minutos 0 (cada hora en punto)
    // if (currentMinute !== 0) {
    //   console.log('⏭️ Skipping - not on the hour');
    //   return {
    //     statusCode: 200,
    //     body: JSON.stringify({ message: 'Skipped - not on the hour' })
    //   };
    // }

    // Obtener configuraciones de WhatsApp habilitadas para esta hora
    const { data: configs, error: configError } = await supabase
      .from('whatsapp_agenda_config')
      .select(`
        *,
        organizations (
          id,
          name
        )
      `)
      .eq('is_enabled', true);

    if (configError) {
      console.error('❌ Error fetching WhatsApp configs:', configError);
      throw configError;
    }

    if (!configs || configs.length === 0) {
      console.log('📭 No WhatsApp configurations found');
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No configurations found' })
      };
    }

    console.log(`📋 Found ${configs.length} WhatsApp configurations`);

    // Filtrar configuraciones que deben ejecutarse en esta hora
    const configsToProcess = configs.filter(config => {
      // Convertir hora UTC actual a la timezone de la organización (MÉTODO ROBUSTO)
      try {
        // Crear un Intl.DateTimeFormat para obtener la hora exacta en la timezone
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: config.timezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false
        });
        
        const parts = formatter.formatToParts(now);
        const orgCurrentHour = parseInt(parts.find(part => part.type === 'hour').value);
        const orgCurrentMinute = parseInt(parts.find(part => part.type === 'minute').value);
        
        console.log(`🕐 DEBUG: UTC ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')} → ${config.timezone} ${orgCurrentHour}:${orgCurrentMinute.toString().padStart(2, '0')}`);
        
        // Parsear hora configurada (formato HH:MM:SS)
        const [configHour, configMinute] = config.send_time.split(':').map(Number);
        
        const shouldProcess = orgCurrentHour === configHour;
        console.log(`🕐 Org ${config.organization_id}: Local ${orgCurrentHour}:${orgCurrentMinute.toString().padStart(2, '0')} vs Config ${configHour}:${(configMinute || 0).toString().padStart(2, '0')} (${config.timezone}) - ${shouldProcess ? 'PROCESAR' : 'ESPERAR'}`);
        
        return shouldProcess;
        
      } catch (error) {
        console.error(`❌ Error converting timezone for ${config.timezone}:`, error);
        // Fallback: usar offset manual para Colombia
        const orgCurrentHour = (now.getHours() - 5 + 24) % 24;
        const [configHour] = config.send_time.split(':').map(Number);
        const shouldProcess = orgCurrentHour === configHour;
        console.log(`🕐 Org ${config.organization_id}: FALLBACK Local ${orgCurrentHour}:00 vs Config ${configHour}:00 - ${shouldProcess ? 'PROCESAR' : 'ESPERAR'}`);
                 return shouldProcess;
       }
    });

    console.log(`🎯 ${configsToProcess.length} configurations to process for hour ${currentHour}`);

    if (configsToProcess.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No configurations for current hour' })
      };
    }

    // Procesar cada configuración
    const results = [];
    
    for (const config of configsToProcess) {
      try {
        console.log(`🏢 Processing organization: ${config.organizations.name}`);
        
        // Obtener citas del día actual para esta organización
        const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
        
        const { data: appointments, error: appointmentsError } = await supabase
          .from('appointments')
          .select(`
            *,
            contacts (
              first_name,
              last_name,
              phone,
              country_code
            ),
            services (
              name,
              duration_minutes
            ),
            profiles!appointments_member_id_fkey (
              first_name,
              last_name
            )
          `)
          .eq('organization_id', config.organization_id)
          .eq('appointment_date', today)
          .neq('status', 'cancelada')
          .order('start_time');

        if (appointmentsError) {
          console.error(`❌ Error fetching appointments for ${config.organizations.name}:`, appointmentsError);
          continue;
        }

        console.log(`📅 Found ${appointments?.length || 0} appointments for today`);

        if (!appointments || appointments.length === 0) {
          console.log(`📭 No appointments for ${config.organizations.name} today`);
          continue;
        }

        // Agrupar citas por miembro
        const memberGroups = {};
        appointments.forEach(appointment => {
          const memberKey = appointment.member_id || 'sin-asignar';
          if (!memberGroups[memberKey]) {
            memberGroups[memberKey] = {
              member: appointment.profiles || { first_name: 'Sin', last_name: 'Asignar' },
              appointments: []
            };
          }
          memberGroups[memberKey].appointments.push(appointment);
        });

        // Generar URL de imagen con manejo de errores robusto
        let imageUrl = null;
        try {
          console.log(`🖼️ Generating agenda image for ${config.organizations.name}...`);
          imageUrl = await generateAgendaImage(config.organizations, memberGroups, today);
          console.log(`✅ Image generated successfully: ${imageUrl}`);
        } catch (imageError) {
          console.error(`❌ Failed to generate image for ${config.organizations.name}:`, imageError.message);
          console.error(`📊 Image error details:`, {
            organization: config.organizations.name,
            appointmentCount: appointments.length,
            memberCount: Object.keys(memberGroups).length,
            error: imageError.message
          });
          // NO enviar webhook si falla la generación de imagen
          results.push({
            organization: config.organizations.name,
            success: false,
            error: `Image generation failed: ${imageError.message}`,
            appointments_count: appointments.length
          });
          continue; // Saltar al siguiente config
        }

        // Solo enviar webhook si se generó la imagen exitosamente
        if (imageUrl) {
          // Preparar payload para webhook
          const payload = {
            event_type: 'daily_agenda',
            organization: config.organizations,
            agenda_date: today,
            image_url: imageUrl,
            recipient_phone: `${config.country_code || '+57'}${config.recipient_phone}`,
            recipient_name: config.recipient_name || 'Destinatario',
            members_with_appointments: Object.values(memberGroups).map(group => ({
              member: group.member,
              appointment_count: group.appointments.length
            })),
            total_appointments: appointments.length
          };

          // Enviar webhook
          const webhookUrl = 'https://auto.skytide.agency/webhook/daily_agenda';
          
          console.log(`📤 Sending webhook to: ${webhookUrl}`);
          console.log(`📱 Recipient: ${payload.recipient_phone} (${payload.recipient_name})`);
          
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            console.error(`⚠️ Webhook failed: ${response.status} ${response.statusText}`);
            console.log(`📋 Payload was: ${JSON.stringify(payload, null, 2)}`);
            // No lanzar error, solo logear - el webhook puede no estar configurado aún
          } else {
            console.log(`✅ Webhook sent successfully for ${config.organizations.name}`);
          }
          
          results.push({
            organization: config.organizations.name,
            status: 'success',
            appointments_count: appointments.length,
            recipient: payload.recipient_phone
          });
        } else {
          console.log(`⏭️ Skipping webhook for ${config.organizations.name} - no image generated`);
          results.push({
            organization: config.organizations.name,
            status: 'skipped',
            reason: 'image_generation_failed',
            appointments_count: appointments.length
          });
        }

      } catch (error) {
        console.error(`❌ Error processing ${config.organizations.name}:`, error);
        results.push({
          organization: config.organizations.name,
          status: 'error',
          error: error.message
        });
      }
    }

    console.log('🎉 WhatsApp Agenda Notifications - Execution completed');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'WhatsApp agenda notifications processed',
        processed_count: configsToProcess.length,
        results: results
      })
    };

  } catch (error) {
    console.error('💥 Fatal error in WhatsApp agenda notifications:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};

// Función para generar imagen de agenda usando HTML → Imagen
async function generateAgendaImage(organization, memberGroups, date) {
  console.log(`🎨 Generating agenda image for ${organization.name} on ${date}`);
  
  try {
    // Generar HTML de la agenda
    const htmlContent = generateAgendaHTML(organization, memberGroups, date);
    
    // Convertir HTML a imagen usando Puppeteer
    const imageBuffer = await htmlToImage(htmlContent);
    
    // Subir imagen a Supabase Storage
    const fileName = `agenda-${organization.id}-${date}-${Date.now()}.png`;
    const { data, error } = await supabase.storage
      .from('agenda-images')
      .upload(fileName, imageBuffer, {
        contentType: 'image/png'
      });
    
    if (error) {
      console.error('❌ Error uploading image to Supabase:', error);
      throw error;
    }
    
    // Obtener URL pública
    const { data: publicUrlData } = supabase.storage
      .from('agenda-images')
      .getPublicUrl(fileName);
    
    console.log(`🖼️ Image uploaded successfully: ${publicUrlData.publicUrl}`);
    return publicUrlData.publicUrl;
    
  } catch (error) {
    console.error('❌ Error generating agenda image:', error);
    
    // No generar fallback, retornar null para indicar fallo
    return null;
  }
}

// Función para convertir HTML a imagen usando Puppeteer-Core + Chromium para Netlify
async function htmlToImage(htmlContent) {
  const { chromium: playwright } = require('playwright-core');
  const chromium = require('@sparticuz/chromium').default;
  
  console.log('🚀 Launching Playwright + @sparticuz/chromium for Netlify Functions...');
  console.log('📦 Using @sparticuz/chromium@137.0.1 + playwright-core@1.53.0 (COMPATIBLE VERSIONS)');
  
  // Configuración OPTIMIZADA para Netlify Functions con @sparticuz/chromium
  // Esta combinación ofrece el mejor soporte para entornos serverless
  
  console.log('🔍 Getting Chromium executable path...');
  const executablePath = await chromium.executablePath();
  console.log(`✅ Chromium executable found at: ${executablePath}`);

  const browser = await playwright.launch({
    args: chromium.args,
    executablePath: executablePath,
    headless: true,
  });
  
  try {
    console.log('📄 Creating new page...');
    const page = await browser.newPage();
    
    // Configurar viewport para imagen de alta calidad
    console.log('🖥️ Setting viewport...');
    await page.setViewportSize({ 
      width: 800, 
      height: 1200
    });
    
    // Cargar HTML
    console.log('📝 Loading HTML content...');
    await page.setContent(htmlContent, {
      waitUntil: 'networkidle',
      timeout: 30000 // 30 segundos timeout
    });
    
    console.log('📸 Taking screenshot...');
    
    // Generar screenshot
    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: true,
      timeout: 30000 // 30 segundos timeout
    });
    
    console.log(`✅ Screenshot generated successfully (${imageBuffer.length} bytes)`);
    
    return imageBuffer;
    
  } catch (error) {
    console.error('❌ Error in htmlToImage:', error.message);
    console.error('📊 Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n') // Primeras 5 líneas del stack
    });
    throw error;
  } finally {
    try {
      await browser.close();
      console.log('🔒 Playwright browser closed successfully');
    } catch (closeError) {
      console.error('⚠️ Error closing browser:', closeError.message);
    }
  }
}

// Función auxiliar para generar HTML de la agenda
function generateAgendaHTML(organization, memberGroups, date) {
  const formatDate = (dateStr) => {
    const options = { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    };
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('es-ES', options);
  };

  // Función para convertir tiempo a minutos desde medianoche
  const timeToMinutes = (timeString) => {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours * 60 + minutes;
  };

  // Función para convertir minutos a formato HH:MM
  const minutesToTime = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  };

  // Estados reales del sistema
  const APPOINTMENT_STATES = {
    'programada': { 
      label: 'Programada', 
      bgColor: '#f3f4f6', 
      borderColor: '#9ca3af', 
      textColor: '#374151' 
    },
    'confirmada': { 
      label: 'Confirmada', 
      bgColor: '#dcfce7', 
      borderColor: '#16a34a', 
      textColor: '#166534' 
    },
    'en_curso': { 
      label: 'En curso', 
      bgColor: '#e0e7ff', 
      borderColor: '#6366f1', 
      textColor: '#4338ca' 
    },
    'completada': { 
      label: 'Completada', 
      bgColor: '#dbeafe', 
      borderColor: '#3b82f6', 
      textColor: '#1e40af' 
    },
    'cancelada': { 
      label: 'Cancelada', 
      bgColor: '#fee2e2', 
      borderColor: '#dc2626', 
      textColor: '#991b1b' 
    },
    'no_asistio': { 
      label: 'No asistió', 
      bgColor: '#fed7aa', 
      borderColor: '#ea580c', 
      textColor: '#9a3412' 
    }
  };

  // Convertir memberGroups a formato array para procesamiento
  const members = Object.values(memberGroups).map(group => ({
    id: group.member.id || 'unknown',
    name: `${group.member.first_name} ${group.member.last_name}`,
    appointments: group.appointments.map(apt => {
      // Calcular end_time si no existe basado en start_time + duración del servicio
      let endTime = apt.end_time;
      if (!endTime && apt.services && apt.services.duration_minutes) {
        const startMinutes = timeToMinutes(apt.start_time);
        const endMinutes = startMinutes + apt.services.duration_minutes;
        endTime = minutesToTime(endMinutes);
      } else if (!endTime) {
        // Fallback: agregar 30 minutos por defecto
        const startMinutes = timeToMinutes(apt.start_time);
        endTime = minutesToTime(startMinutes + 30);
      }
      
      return {
        start_time: apt.start_time,
        end_time: endTime,
        client: `${apt.contacts.first_name} ${apt.contacts.last_name}`,
        service: apt.services.name,
        status: apt.status || 'programada'
      };
    })
  }));

  // Calcular horario automático basado en las citas del día
  let earliestTime = 24 * 60; // 24:00 en minutos
  let latestTime = 0; // 00:00 en minutos
  
  // Encontrar la cita más temprana y más tardía
  members.forEach(member => {
    member.appointments.forEach(appointment => {
      const startMin = timeToMinutes(appointment.start_time);
      const endMin = timeToMinutes(appointment.end_time);
      
      if (startMin < earliestTime) earliestTime = startMin;
      if (endMin > latestTime) latestTime = endMin;
    });
  });
  
  // Si no hay citas, usar horario por defecto
  if (earliestTime === 24 * 60) {
    earliestTime = 8 * 60; // 8:00 AM
    latestTime = 18 * 60;  // 6:00 PM
  } else {
    // Agregar margen de 1 hora antes y después
    earliestTime = Math.max(0, earliestTime - 60); // No antes de 00:00
    latestTime = Math.min(24 * 60, latestTime + 60); // No después de 24:00
  }
  
  const startHour = Math.floor(earliestTime / 60);
  const endHour = Math.ceil(latestTime / 60);
  const totalMinutes = (endHour - startHour) * 60;
  const startMinutes = startHour * 60;

  // Detectar overlaps y organizar citas lado a lado
  const processedMembers = members.map(member => {
    const sortedAppointments = [...member.appointments].sort((a, b) => 
      timeToMinutes(a.start_time) - timeToMinutes(b.start_time)
    );

    const appointmentsWithColumns = [];
    
    sortedAppointments.forEach(appointment => {
      const startMin = timeToMinutes(appointment.start_time);
      const endMin = timeToMinutes(appointment.end_time);
      
      // Buscar qué columna puede usar (detectar overlaps)
      let column = 0;
      while (appointmentsWithColumns.some(existing => 
        existing.column === column &&
        !(endMin <= timeToMinutes(existing.start_time) || startMin >= timeToMinutes(existing.end_time))
      )) {
        column++;
      }
      
      appointmentsWithColumns.push({
        ...appointment,
        column,
        startMinutes: startMin,
        endMinutes: endMin,
        duration: endMin - startMin
      });
    });

    const maxColumns = Math.max(...appointmentsWithColumns.map(apt => apt.column), 0) + 1;
    
    return {
      ...member,
      appointments: appointmentsWithColumns,
      maxColumns
    };
  });

  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #f8fafc;
          padding: 20px;
          line-height: 1.4;
        }
        
        .header {
          text-align: center;
          margin-bottom: 30px;
          background: white;
          padding: 25px;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        .header h1 {
          color: #1e293b;
          font-size: 42px;
          margin-bottom: 8px;
          font-weight: 700;
        }
        
        .header h2 {
          color: #64748b;
          font-size: 23px;
          font-weight: 500;
          text-transform: capitalize;
        }
        
        .calendar-container {
          background: white;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          margin-bottom: 20px;
        }
        
        .calendar-header {
          display: grid;
          grid-template-columns: 100px repeat(${members.length}, 1fr);
          border-bottom: 2px solid #cbd5e1;
        }
        
        .time-header {
          background: #f1f5f9;
          font-weight: 600;
          color: #475569;
          text-align: center;
          padding: 16px 12px;
          border-right: 1px solid #cbd5e1;
          font-size: 17px;
        }
        
        .member-header {
          background: #000000;
          color: white;
          font-weight: 600;
          text-align: center;
          font-size: 21px;
          padding: 16px 12px;
          border-right: 1px solid #cbd5e1;
        }
        
        .calendar-body {
          display: grid;
          grid-template-columns: 100px repeat(${members.length}, 1fr);
          position: relative;
        }
        
        .time-column {
          background: #f8fafc;
          border-right: 1px solid #cbd5e1;
        }
        
        .time-slot {
          height: 60px;
          border-bottom: 1px solid #cbd5e1;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 17px;
          font-weight: 500;
          color: #64748b;
        }
        
        .member-column {
          position: relative;
          border-right: 1px solid #cbd5e1;
          background: white;
        }
        
        .time-grid-line {
          position: absolute;
          left: 0;
          right: 0;
          height: 1px;
          background: #cbd5e1;
          z-index: 1;
        }
        
        .appointment {
          position: absolute;
          left: 4px;
          right: 4px;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 14px;
          border: 1px solid;
          z-index: 10;
          overflow: hidden;
        }
        
        .appointment-overlap {
          right: 50% !important;
          margin-right: 2px;
        }
        
        .appointment-overlap.column-1 {
          left: 50% !important;
          right: 4px !important;
          margin-left: 2px;
          margin-right: 0;
        }
        
        .appointment-client {
          font-weight: 600;
          margin-bottom: 2px;
          font-size: 16px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        .appointment-service {
          font-size: 13px;
          opacity: 0.9;
          margin-bottom: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        .appointment-time {
          font-size: 12px;
          opacity: 0.7;
          font-weight: 500;
        }
        
        .legend {
          display: flex;
          justify-content: center;
          gap: 20px;
          padding: 20px;
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          flex-wrap: wrap;
        }
        
        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 16px;
          font-weight: 500;
        }
        
        .legend-dot {
          width: 16px;
          height: 16px;
          border-radius: 4px;
          border: 1px solid;
        }
        
        ${Object.entries(APPOINTMENT_STATES).map(([status, config]) => `
          .appointment.${status} {
            background: ${config.bgColor};
            border-color: ${config.borderColor};
            color: ${config.textColor};
          }
          .legend-dot.${status} {
            background: ${config.bgColor};
            border-color: ${config.borderColor};
          }
        `).join('')}
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📅 Agenda Diaria ${organization.name}</h1>
        <h2>${formatDate(date)}</h2>
      </div>
      
      <div class="calendar-container">
        <div class="calendar-header">
          <div class="time-header">Hora</div>
          ${members.map(member => `<div class="member-header">${member.name}</div>`).join('')}
        </div>
        
        <div class="calendar-body">
          <!-- Time column -->
          <div class="time-column">
            ${Array.from({length: (endHour - startHour) * 2}, (_, i) => {
              const minutes = startMinutes + (i * 30);
              const time = minutesToTime(minutes);
              return `<div class="time-slot">${time}</div>`;
            }).join('')}
          </div>
          
          <!-- Member columns -->
          ${processedMembers.map((member, memberIndex) => `
            <div class="member-column" style="height: ${(endHour - startHour) * 120}px;">
              <!-- Grid lines every 30 minutes -->
              ${Array.from({length: (endHour - startHour) * 2 + 1}, (_, i) => 
                `<div class="time-grid-line" style="top: ${i * 60}px;"></div>`
              ).join('')}
              
              <!-- Appointments -->
              ${member.appointments.map(appointment => {
                const topPosition = ((appointment.startMinutes - startMinutes) / totalMinutes) * ((endHour - startHour) * 120);
                const height = (appointment.duration / totalMinutes) * ((endHour - startHour) * 120);
                const hasOverlap = member.maxColumns > 1;
                
                return `
                  <div class="appointment ${appointment.status} ${hasOverlap ? 'appointment-overlap' : ''} ${appointment.column > 0 ? 'column-' + appointment.column : ''}" 
                       style="top: ${topPosition}px; height: ${height}px;">
                    <div class="appointment-client">${appointment.client}</div>
                    <div class="appointment-service">${appointment.service}</div>
                    <div class="appointment-time">${appointment.start_time} - ${appointment.end_time}</div>
                  </div>
                `;
              }).join('')}
            </div>
          `).join('')}
        </div>
      </div>
      
      <div class="legend">
        ${Object.entries(APPOINTMENT_STATES).map(([status, config]) => `
          <div class="legend-item">
            <div class="legend-dot ${status}"></div>
            <span>${config.label}</span>
          </div>
        `).join('')}
      </div>
    </body>
    </html>
  `;

  return html;
} 