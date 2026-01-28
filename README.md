# Tote Backend

Backend API para gestión de totes con base de datos MySQL containerizada en Docker.

## 🌐 Aplicación Web

El backend incluye una aplicación web Vue.js para visualizar los totes:

- **URL Local**: `http://localhost:3000/app/`
- **URL Docker**: `http://localhost:3000/app/`

La aplicación web incluye:
- 📦 Lista completa de totes con auto-refresh
- 📊 Estadísticas en tiempo real
- 🔄 Actualización automática cada 30 segundos
- 📱 Diseño responsive

Para compilar el frontend desde cero, ir al directorio `../tote-frontend/` y ejecutar `npm run build:backend`

## Características

- API RESTful construida con Express.js
- Base de datos MySQL 8.0 en contenedor Docker
- Endpoints para crear, consultar y actualizar información de totes
- Rate limiting para seguridad (100 requests por 15 minutos por IP)
- Dockerizado con docker-compose para fácil deployment

## Estructura de Datos del Tote

Cada tote contiene los siguientes campos:

### Campos obligatorios al crear:
- `tote_id` (string): Identificador único del tote
- `tote_kg` (unsigned integer): Peso del tote en kilogramos
- `water_kg` (unsigned integer): Peso del agua en kilogramos
- `ice_kg` (unsigned integer): Peso del hielo en kilogramos
- `raw_kg` (unsigned integer): Peso raw en kilogramos
- `water_out_kg` (unsigned integer): Peso del agua de salida en kilogramos

### Campos opcionales (nullable - se actualizan posteriormente):
- `fish_kg` (unsigned integer): Peso del pescado en kilogramos
- `ice_out_kg` (unsigned integer): Peso del hielo de salida en kilogramos
- `temp_out` (decimal): Temperatura de salida

### Campo automático:
- `created_at` (timestamp): Fecha y hora de creación (se genera automáticamente)

## Requisitos

- Docker
- Docker Compose

## Instalación y Ejecución con Docker

### 1. Iniciar los servicios

```bash
docker-compose up -d
```

Este comando iniciará:
- MySQL 8.0 (puerto 3306)
- Backend API (puerto 3000)

### 2. Ver logs

```bash
# Ver logs de todos los servicios
docker-compose logs -f

# Ver logs solo del backend
docker-compose logs -f backend

# Ver logs solo de la base de datos
docker-compose logs -f db
```

### 3. Detener los servicios

```bash
docker-compose down
```

### 4. Detener y eliminar volúmenes (elimina datos de la BD)

```bash
docker-compose down -v
```

### 5. Reconstruir la imagen (si modificaste el código)

```bash
docker-compose build --no-cache
docker-compose up -d
```

## API Endpoints

### 1. Crear un Tote
**POST** `/api/totes`

Crea un nuevo tote con los datos iniciales. Los campos `fish_kg`, `ice_out_kg` y `temp_out` son opcionales.

Request body:
```json
{
  "tote_id": "TOTE001",
  "tote_kg": 100,
  "water_kg": 50,
  "ice_kg": 30,
  "raw_kg": 150,
  "water_out_kg": 40
}
```

Response (201 Created):
```json
{
  "message": "Tote added successfully",
  "tote": {
    "tote_id": "TOTE001",
    "tote_kg": 100,
    "water_kg": 50,
    "ice_kg": 30,
    "fish_kg": null,
    "raw_kg": 150,
    "ice_out_kg": null,
    "water_out_kg": 40,
    "temp_out": null
  }
}
```

### 2. Obtener Todos los Totes
**GET** `/api/totes`

Response (200 OK):
```json
{
  "totes": [
    {
      "tote_id": "TOTE001",
      "tote_kg": 100,
      "water_kg": 50,
      "ice_kg": 30,
      "fish_kg": null,
      "raw_kg": 150,
      "ice_out_kg": null,
      "water_out_kg": 40,
      "temp_out": null,
      "created_at": "2026-01-07T22:42:33.000Z"
    }
  ]
}
```

### 3. Obtener un Tote Específico
**GET** `/api/totes/:id`

Response (200 OK):
```json
{
  "tote": {
    "tote_id": "TOTE001",
    "tote_kg": 100,
    "water_kg": 50,
    "ice_kg": 30,
    "fish_kg": null,
    "raw_kg": 150,
    "ice_out_kg": null,
    "water_out_kg": 40,
    "temp_out": null,
    "created_at": "2026-01-07T22:42:33.000Z"
  }
}
```

### 4. Actualizar un Tote (Nuevo)
**PUT** `/api/totes/:id`

Actualiza los campos opcionales del tote (fish_kg, ice_out_kg, temp_out). Solo se actualizan los campos enviados en el request.

Request body:
```json
{
  "fish_kg": 200,
  "ice_out_kg": 20,
  "temp_out": 2.5
}
```

Response (200 OK):
```json
{
  "message": "Tote updated successfully",
  "tote": {
    "tote_id": "TOTE001",
    "tote_kg": 100,
    "water_kg": 50,
    "ice_kg": 30,
    "fish_kg": 200,
    "raw_kg": 150,
    "ice_out_kg": 20,
    "water_out_kg": 40,
    "temp_out": 2.5,
    "created_at": "2026-01-07T22:42:33.000Z"
  }
}
```

## Ejemplos de Uso con curl

### Crear un tote
```bash
curl -X POST http://localhost:3000/api/totes \
  -H "Content-Type: application/json" \
  -d '{
    "tote_id": "TOTE001",
    "tote_kg": 100,
    "water_kg": 50,
    "ice_kg": 30,
    "raw_kg": 150,
    "water_out_kg": 40
  }'
```

### Actualizar un tote con datos de salida
```bash
curl -X PUT http://localhost:3000/api/totes/TOTE001 \
  -H "Content-Type: application/json" \
  -d '{
    "fish_kg": 200,
    "ice_out_kg": 20,
    "temp_out": 2.5
  }'
```

### Obtener todos los totes
```bash
curl http://localhost:3000/api/totes
```

### Obtener un tote específico
```bash
curl http://localhost:3000/api/totes/TOTE001
```

## Configuración de la Base de Datos

La configuración por defecto se encuentra en `docker-compose.yml`:
- Host: db (nombre del contenedor)
- User: tote_user
- Password: totepassword
- Database: tote_db
- Puerto: 3306

Puedes personalizar estos valores creando un archivo `.env` basado en `.env.example`.

## Estructura del Proyecto

```
Tote_backend/
├── index.js           # Servidor Express y endpoints
├── db.js              # Configuración de conexión a MySQL
├── init-db.js         # Script de inicialización de BD
├── package.json       # Dependencias del proyecto
├── Dockerfile         # Imagen Docker del backend
├── docker-compose.yml # Orquestación de servicios
├── .dockerignore      # Archivos excluidos de la imagen
├── .env.example       # Ejemplo de variables de entorno
└── README.md          # Esta documentación
```

## Acceso Directo a MySQL

Para acceder directamente a la base de datos MySQL:

```bash
docker exec -it tote_mysql mysql -u tote_user -ptotepassword tote_db
```

Ver estructura de la tabla:
```bash
docker exec -it tote_mysql mysql -u tote_user -ptotepassword tote_db -e "DESCRIBE totes;"
```

## Desarrollo Local sin Docker

Si prefieres ejecutar sin Docker:

1. Instala las dependencias:
```bash
npm install
```

2. Configura MySQL localmente y actualiza las variables de entorno

3. Inicializa la base de datos:
```bash
npm run init-db
```

4. Inicia el servidor:
```bash
npm start
```

## License

ISC
