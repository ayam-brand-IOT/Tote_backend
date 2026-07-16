# Tote Backend

Backend API for tote management with MySQL database containerized in Docker.

## 🌐 Web Application

The backend includes a Vue.js web application to visualize totes:

- **Local URL**: `http://localhost:3000/app/`
- **Docker URL**: `http://localhost:3000/app/`

The web application includes:
- 📦 Complete tote list with auto-refresh
- 📊 Real-time statistics
- 🔄 Automatic update every 30 seconds
- 📱 Responsive design

To compile the frontend from scratch, go to the `../tote-frontend/` directory and run `npm run build:backend`

## Manager Dashboard & Demo Data

The web app opens on a **manager dashboard** (`/app/`) focused on production-line
productivity: fish processed (kg) per line, live status, throughput charts and
tote status distribution. Totes are still fully recorded but presented as
traceability.

- **Analytics endpoint**: `GET /api/analytics/dashboard?range=today|7d|30d`
  returns per-line output, KPI summary with period deltas, a per-line throughput
  timeseries (hourly for `today`, daily otherwise), tote status breakdown and top
  products.
- **Seed demo data** (needs the DB up and schema initialized):

  ```bash
  npm run init-db   # (destructive) create schema
  npm run seed      # ~4 weeks of realistic production history
  DAYS=14 npm run seed   # custom window
  ```

  `seed.js` is non-destructive to tables: it clears and regenerates totes,
  line/product assignments and products, keeping the production lines.

## Authentication & Roles

The portal requires login. Two roles:

- **management** (the plant manager): full access, including the **Config** area
  (production lines, destinations, fish types, sizes) and **user management**.
- **production**: everything except Config and user management.

The REST API (`/api/*`, except `/api/auth/login`) requires a bearer token; the
ESP32 hardware is unaffected because it only uses the WebSocket. Auth uses Node's
built-in `crypto` (scrypt password hashing + HMAC-signed tokens) — no extra deps.

Default accounts are seeded on first server start (change them in Config):

| Username | Password | Role |
| --- | --- | --- |
| `manager` | `manager123` | management |
| `operator` | `operator123` | production |

Override seed passwords with `DEFAULT_MANAGER_PW` / `DEFAULT_OPERATOR_PW`, and set
`JWT_SECRET` (and optionally `TOKEN_TTL` seconds) in production.

Key endpoints: `POST /api/auth/login`, `GET /api/auth/me`, `GET/POST/PUT/DELETE
/api/users` (management), `GET /api/config/options` + management writes.

## Features

- RESTful API built with Express.js
- MySQL 8.0 database in Docker container
- Endpoints to create, query, and update tote information
- Rate limiting for security (100 requests per 15 minutes per IP)
- Dockerized with docker-compose for easy deployment

## Tote Inventory (physical assets)

The `tote_assets` table is the physical tote inventory — the real reusable
containers identified by their printed/QR label. It is the source of truth for
which tote IDs are valid.

- `totes.tote_id` is a **foreign key** to `tote_assets(tote_id)` (`ON DELETE
  RESTRICT`), so creating a processing record with an unknown tote is rejected
  (`POST /api/totes` returns a clear 400 for unknown or non-`active` totes).
- One physical tote → many processing records (it is reused across trips). This
  is purely for traceability.
- `init-db.js` seeds the inventory **T001..T099** for testing. A running server
  also creates + seeds the table and adds the FK idempotently via `ensureSchema()`
  (existing free-text tote IDs are backfilled as assets before the FK is added).
- Each tote has a `status`: `active` (default), `maintenance`, or `retired`.
  Only `active` totes accept new processing records.

Inventory endpoints (reads: any authed user; writes: management only):
`GET /api/tote-assets` (with per-tote trip count + last-used), `POST /api/tote-assets`,
`PUT /api/tote-assets/:id` (status/comments), `DELETE /api/tote-assets/:id`
(blocked with 409 if the tote has processing history — retire it instead).

## Tote Data Structure

Each tote contains the following fields:

### Required fields when creating:
- `tote_id` (string): FK to `tote_assets` — must be a real tote in the inventory
- `tote_kg` (unsigned integer): Tote weight in kilograms
- `water_kg` (unsigned integer): Water weight in kilograms
- `ice_kg` (unsigned integer): Ice weight in kilograms
- `raw_kg` (unsigned integer): Raw weight in kilograms
- `water_out_kg` (unsigned integer): Output water weight in kilograms

### Optional fields (nullable - updated later):
- `fish_kg` (unsigned integer): Fish weight in kilograms
- `ice_out_kg` (unsigned integer): Output ice weight in kilograms
- `temp_out` (decimal): Output temperature

### Automatic field:
- `created_at` (timestamp): Creation date and time (generated automatically)

## Requirements

- Docker
- Docker Compose

## Installation and Execution with Docker

### 1. Start the services

```bash
docker-compose up -d
```

This command will start:
- MySQL 8.0 (port 3306)
- Backend API (port 3000)

### 2. View logs

```bash
# View logs for all services
docker-compose logs -f

# View logs for backend only
docker-compose logs -f backend

# View logs for database only
docker-compose logs -f db
```

### 3. Stop the services

```bash
docker-compose down
```

### 4. Stop and remove volumes (deletes DB data)

```bash
docker-compose down -v
```

### 5. Rebuild the image (if you modified the code)

```bash
docker-compose build --no-cache
docker-compose up -d
```

## API Endpoints

### 1. Create a Tote
**POST** `/api/totes`

Creates a new tote with initial data. The fields `fish_kg`, `ice_out_kg` and `temp_out` are optional.

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

### 2. Get All Totes
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

### 3. Get a Specific Tote
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

### 4. Update a Tote (New)
**PUT** `/api/totes/:id`

Updates the optional fields of the tote (fish_kg, ice_out_kg, temp_out). Only the fields sent in the request are updated.

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

## Usage Examples with curl

### Create a tote
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

### Update a tote with output data
```bash
curl -X PUT http://localhost:3000/api/totes/TOTE001 \
  -H "Content-Type: application/json" \
  -d '{
    "fish_kg": 200,
    "ice_out_kg": 20,
    "temp_out": 2.5
  }'
```

### Get all totes
```bash
curl http://localhost:3000/api/totes
```

### Get a specific tote
```bash
curl http://localhost:3000/api/totes/TOTE001
```

## Database Configuration

The default configuration is in `docker-compose.yml`:
- Host: db (container name)
- User: tote_user
- Password: totepassword
- Database: tote_db
- Port: 3306

You can customize these values by creating a `.env` file based on `.env.example`.

## Project Structure

```
Tote_backend/
├── index.js           # Express server and endpoints
├── db.js              # MySQL connection configuration
├── init-db.js         # DB initialization script
├── package.json       # Project dependencies
├── Dockerfile         # Backend Docker image
├── docker-compose.yml # Service orchestration
├── .dockerignore      # Files excluded from image
├── .env.example       # Environment variables example
└── README.md          # This documentation
```

## Direct MySQL Access

To access the MySQL database directly:

```bash
docker exec -it tote_mysql mysql -u tote_user -ptotepassword tote_db
```

View table structure:
```bash
docker exec -it tote_mysql mysql -u tote_user -ptotepassword tote_db -e "DESCRIBE totes;"
```

## Local Development without Docker

If you prefer to run without Docker:

1. Install dependencies:
```bash
npm install
```

2. Configure MySQL locally and update environment variables

3. Initialize the database:
```bash
npm run init-db
```

4. Start the server:
```bash
npm start
```

## License

ISC
