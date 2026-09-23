# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sealaf is a serverless function computing platform that deeply integrates [Laf](https://github.com/labring/laf) and [Sealos](https://github.com/labring/sealos). It provides Backend-as-a-Service (BaaS) capabilities including cloud functions, databases, storage, and billing management. The project is organized as a Lerna monorepo with two main packages:

- **server**: NestJS-based API server managing all backend operations
- **web**: React/Vite-based frontend providing the development interface

## Development Commands

### Root Level
```bash
# Install all dependencies for both server and web
npm install  # or: lerna exec npm install --parallel

# Lint all packages
npm run lint  # or: lerna run lint --parallel

# Lint staged files (pre-commit)
npm run lint-staged  # or: lerna exec --since HEAD --parallel -- lint-staged --no-stash

# Build all packages
npm run build  # or: lerna run build --parallel

# Watch mode for development
npm run watch  # or: lerna run watch --parallel

# Clean build artifacts
npm run clean:build
```

### Server (NestJS Backend)

Located in `server/` directory:

```bash
# Development with hot reload
npm run dev  # or: nest start --watch

# Build for production
npm run build  # or: nest build

# Start production server
npm run start:prod  # or: node dist/main

# Run tests
npm test  # or: jest
npm run test:watch  # Jest in watch mode
npm run test:cov  # With coverage
npm run test:e2e  # End-to-end tests

# Run single test file
npm test -- path/to/test.spec.ts

# Lint
npm run lint  # or: eslint "{src,apps,libs,test}/**/*.ts" --fix

# Local development with Telepresence (requires Kubernetes cluster)
npm run intercept  # Connect to laf-server in laf-system namespace
npm run leave      # Disconnect telepresence
```

**Server runs on port 3000** and exposes Swagger API docs at `http://localhost:3000`.

### Web (React/Vite Frontend)

Located in `web/` directory:

```bash
# Development server
npm run dev  # or: node --experimental-import-meta-resolve ./node_modules/vite/bin/vite.js

# Build for production
npm run build  # or: tsc && node --max_old_space_size=32768 ./node_modules/vite/bin/vite.js build

# Type checking only
npm run tsc

# Preview production build
npm run preview

# Lint
npm run lint  # or: eslint src --fix

# Local development with Telepresence (requires Kubernetes cluster)
npm run intercept  # Connect to laf-web in laf-system namespace
npm run leave      # Disconnect telepresence
```

**Web dev server runs on port 3001** (or as configured in vite.config.ts).

### Building Docker Images

From repository root:

```bash
# Build web image
cd web
docker build -t docker.io/zacharywin/sealaf-web:latest -f Dockerfile .

# Build server image
cd ../server
docker build -t docker.io/zacharywin/sealaf-server:latest -f Dockerfile .

# Build Sealos deployment package
cd ../deploy
sealos build -t docker.io/zacharywin/sealaf:latest --platform linux/amd64 -f Kubefile .
```

## Architecture Overview

### Server Architecture

The server is a **NestJS** application organized into feature modules:

**Core Application Management:**
- `application/`: Application lifecycle, bundle configuration, environment variables, and pod management
- `instance/`: Runtime instance management and task scheduling
- `gateway/`: Ingress, runtime domains, and TLS certificate management

**Function Execution:**
- `function/`: Cloud function CRUD operations
- `trigger/`: Scheduled triggers (cron jobs) for functions
- `dependency/`: NPM dependency management for runtime environments

**Data & Storage:**
- `database/`: MongoDB database provisioning and management per application
- `storage/`: Object storage (MinIO/S3) bucket management

**Authentication & User Management:**
- `authentication/`: JWT-based auth, OAuth integration (GitHub, WeChat Pay)
- `user/`: User accounts and profiles
- `billing/`: Usage tracking, pricing, and payment integration

**Infrastructure:**
- `region/`: Multi-region cluster configuration
- `initializer/`: System bootstrapping and initialization
- `monitor/`: Prometheus metrics integration for app and database monitoring
- `log/`: Application runtime log aggregation

**System Components:**
- `system-database.ts`: MongoDB system database singleton
- `constants.ts`: Server configuration from environment variables
- `runtime-builtin-deps.ts`: Built-in runtime dependencies

**Kubernetes Integration:**
The server uses `@kubernetes/client-node` to manage applications as Kubernetes resources. Each application is deployed as a pod with runtime containers.

### Web Architecture

The web frontend is a **React 18** SPA using:

**Routing & State:**
- `react-router-dom` v6 for routing (see `routes/index.tsx`)
- `zustand` + `immer` for global state management
- Page-level stores in `pages/*/globalStore.ts` and `pages/siteSetting.ts`

**Data Fetching:**
- `@tanstack/react-query` v4 for server state
- `axios` for HTTP requests (configured in `apis/`)

**UI Framework:**
- **Chakra UI** v2 as the component library
- Dual theme support: `chakraTheme.ts` (light) and `chakraThemeDark.ts` (dark)
- Tailwind CSS for utility styling
- SASS for custom styles

**Key Features:**
- Monaco Editor integration for cloud function editing (`@monaco-editor/react`)
- Sealos Desktop SDK integration (`@labring/sealos-desktop-sdk`)
- i18next for internationalization
- Sentry for error tracking and performance monitoring

**Page Structure:**
- `/pages/auth`: Authentication and login
- `/pages/home`: Dashboard (at `/dashboard`)
- `/pages/app`: Main application workspace (functions, databases, storage, logs)
- `/pages/functionTemplate`: Function template marketplace

**Layouts:**
- `BasicLayout`: For dashboard pages
- `FunctionLayout`: For application workspace
- `TemplateLayout`: For template marketplace

### System Database Schema

The system uses MongoDB with collections for:
- Applications (apps)
- Functions
- Triggers
- Users
- Regions
- Billing records
- Runtime instances
- Storage buckets
- Databases

Each application gets its own isolated MongoDB database created on-demand.

### Runtime Environment

Applications run in Kubernetes pods with:
- **Init container**: `runtime-node-init` - installs custom NPM dependencies
- **Main container**: `runtime-node` - executes cloud functions
- **database-proxy**: Sidecar providing secure database access

Functions are compiled and published to a special MongoDB collection (`__functions__`) and loaded by the runtime.

## Key Development Patterns

### Server Patterns

1. **Module Structure**: Each feature is a NestJS module with controller, service, and DTOs
2. **Task Services**: Background jobs use `@nestjs/schedule` (e.g., `application-task.service.ts`, `instance-task.service.ts`)
3. **Validation**: DTOs use `class-validator` decorators
4. **Authentication**: JWT guards via `@nestjs/passport` and `passport-jwt`
5. **Event-Driven**: Uses `@nestjs/event-emitter` for inter-module communication
6. **K8s Resources**: Applications are managed as Kubernetes custom resources and pods

### Web Patterns

1. **API Hooks**: Custom React Query hooks in `apis/` for data fetching
2. **Store Pattern**: Zustand stores with immer middleware for immutable updates
3. **Component Organization**: Feature-based structure under `pages/`, shared components in `components/`
4. **Lazy Loading**: Routes use dynamic imports for code splitting
5. **Type Safety**: TypeScript throughout with strict mode enabled

## Environment Variables

### Server (.env)

Required variables (see `server/src/constants.ts`):
- `DATABASE_URL`: MongoDB connection string for system database
- `JWT_SECRET`: Secret for JWT token signing
- `DEFAULT_REGION_RUNTIME_DOMAIN`: Base domain for application runtime URLs

Optional configuration:
- `DEFAULT_LANGUAGE`: i18n default (default: `en`)
- `JWT_EXPIRES_IN`: Token expiration (default: `7d`)
- `API_SERVER_URL`: Server URL for Swagger docs
- `APPID_LENGTH`: Application ID length (default: 10)
- `DEFAULT_RUNTIME_IMAGE`: Docker image for function runtime
- `DEFAULT_RUNTIME_INIT_IMAGE`: Docker image for init container
- `APP_MONITOR_URL`: Prometheus endpoint for app metrics
- `DATABASE_MONITOR_URL`: Prometheus endpoint for database metrics

Task switches (set to `'true'` to disable):
- `DISABLED_INSTANCE_TASK`
- `DISABLED_APPLICATION_TASK`
- `DISABLED_GATEWAY_TASK`
- `DISABLED_TRIGGER_TASK`

### Web (.env)

- `VITE_SENTRY_DSN`: Sentry error tracking DSN
- `VITE_GITHUB_SHA`: Git commit SHA for release tracking

## Local Development with Telepresence

For working on server or web while connected to a remote Kubernetes cluster:

1. Install telepresence: https://www.telepresence.io/reference/install
2. Connect to cluster: `telepresence connect -n laf-system`
3. Intercept service:
   - Server: `cd server && npm run intercept`
   - Web: `cd web && npm run intercept`
4. Run local dev server
5. Clean up: `npm run leave`

This allows local code to receive traffic from the cluster while accessing cluster services.

## Deployment

Sealaf is deployed to Kubernetes using Sealos:

1. Ensure object storage (MinIO operator) is installed
2. Create `wildcard-cert` secret in `sealaf-system` namespace
3. Run: `sealos run docker.io/zacharywin/sealaf:latest --env cloudDomain="your-domain"`

Deployment manifests are in `deploy/manifests/`:
- `serviceaccount.yaml`: RBAC for server
- `appcr.yaml.tmpl`: Custom resource definitions
- `deploy.yaml.tmpl`: Server and web deployments
- `ingress.yaml.tmpl`: Ingress configuration
- `mongodb.yaml.tmpl`: System database

## Technology Stack Summary

**Server:**
- NestJS 9, Node.js, TypeScript 4.9
- MongoDB (via native driver)
- Kubernetes client
- JWT authentication
- MinIO/S3 for object storage
- Swagger/OpenAPI documentation
- Jest for testing

**Web:**
- React 18, TypeScript 5.0
- Vite 4 for build tooling
- Chakra UI + Tailwind CSS
- React Query + Zustand
- Monaco Editor
- i18next for i18n
- Sentry for monitoring

**Infrastructure:**
- Kubernetes for orchestration
- Sealos for deployment
- MinIO for object storage
- Prometheus for metrics
- Telepresence for local development
