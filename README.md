# Tote_backend

A Node.js backend API for managing tote data with MySQL database.

## Features

- RESTful API built with Express.js
- MySQL database for data persistence
- Endpoints to add and retrieve tote information

## Tote Data Structure

Each tote contains the following fields:
- `id` (string): Unique identifier for the tote
- `water_weight` (unsigned integer): Weight of water in the tote
- `ice_weight` (unsigned integer): Weight of ice in the tote
- `tote_weight` (unsigned integer): Weight of the tote itself
- `raw_weight` (unsigned integer): Raw weight measurement

## Prerequisites

- Node.js (v14 or higher)
- MySQL server

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables (optional):
   - Copy `.env.example` to `.env`
   - Update the values as needed

4. Initialize the database:
   ```bash
   npm run init-db
   ```

## Running the Server

Start the server:
```bash
npm start
```

The server will run on port 3000 by default (or the port specified in the PORT environment variable).

## API Endpoints

### Add a Tote
**POST** `/api/totes`

Request body:
```json
{
  "id": "TOTE001",
  "water_weight": 1000,
  "ice_weight": 500,
  "tote_weight": 200,
  "raw_weight": 1700
}
```

Response (201 Created):
```json
{
  "message": "Tote added successfully",
  "tote": {
    "id": "TOTE001",
    "water_weight": 1000,
    "ice_weight": 500,
    "tote_weight": 200,
    "raw_weight": 1700
  }
}
```

### Get All Totes
**GET** `/api/totes`

Response (200 OK):
```json
{
  "totes": [
    {
      "id": "TOTE001",
      "water_weight": 1000,
      "ice_weight": 500,
      "tote_weight": 200,
      "raw_weight": 1700,
      "created_at": "2025-12-03T18:34:16.000Z"
    }
  ]
}
```

### Get a Specific Tote
**GET** `/api/totes/:id`

Response (200 OK):
```json
{
  "tote": {
    "id": "TOTE001",
    "water_weight": 1000,
    "ice_weight": 500,
    "tote_weight": 200,
    "raw_weight": 1700,
    "created_at": "2025-12-03T18:34:16.000Z"
  }
}
```

## Database Configuration

The default database configuration is:
- Host: localhost
- User: root
- Password: (empty)
- Database: tote_db

You can override these values using environment variables in a `.env` file.

## License

ISC
