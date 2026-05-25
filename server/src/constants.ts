import * as dotenv from 'dotenv' // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
dotenv.config({ path: '.env.local' })
dotenv.config()

export class ServerConfig {
  static get DEFAULT_LANGUAGE() {
    return process.env.DEFAULT_LANGUAGE || 'en'
  }

  static get DATABASE_URL() {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not defined')
    }
    return process.env.DATABASE_URL
  }

  static get JWT_SECRET() {
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined')
    }
    return process.env.JWT_SECRET
  }

  static get JWT_EXPIRES_IN() {
    return process.env.JWT_EXPIRES_IN || '7d'
  }

  /* switcher of task controllers */

  static get DISABLED_INSTANCE_TASK() {
    return process.env.DISABLED_INSTANCE_TASK === 'true'
  }

  static get DISABLED_APPLICATION_TASK() {
    return process.env.DISABLED_APPLICATION_TASK === 'true'
  }

  static get DISABLED_GATEWAY_TASK() {
    return process.env.DISABLED_GATEWAY_TASK === 'true'
  }

  static get DISABLED_TRIGGER_TASK() {
    return process.env.DISABLED_TRIGGER_TASK === 'true'
  }

  static get APPID_LENGTH(): number {
    return parseInt(process.env.APPID_LENGTH || '10')
  }

  static get RUNTIME_CUSTOM_DEPENDENCY_BASE_PATH() {
    return (
      process.env.RUNTIME_CUSTOM_DEPENDENCY_BASE_PATH ||
      '/tmp/custom_dependency'
    )
  }

  static get DEFAULT_RUNTIME_IMAGE() {
    const image =
      process.env.DEFAULT_RUNTIME_IMAGE ||
      'docker.io/lafyun/runtime-node:latest'

    const initImage =
      process.env.DEFAULT_RUNTIME_INIT_IMAGE ||
      'docker.io/lafyun/runtime-node-init:latest'
    return {
      image: {
        main: image,
        init: initImage,
      },
      version: 'latest',
    }
  }

  static get API_SERVER_URL() {
    return process.env.API_SERVER_URL || 'http://localhost:3000'
  }

  static get DEFAULT_REGION_RUNTIME_DOMAIN() {
    if (!process.env.DEFAULT_REGION_RUNTIME_DOMAIN) {
      throw new Error('DEFAULT_REGION_RUNTIME_DOMAIN is not defined')
    }
    return process.env.DEFAULT_REGION_RUNTIME_DOMAIN
  }

  static get DEFAULT_REGION_TLS_ENABLED() {
    return process.env.DEFAULT_REGION_TLS_ENABLED === 'true'
  }

  static get DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME() {
    return process.env.DEFAULT_REGION_TLS_WILDCARD_CERTIFICATE_SECRET_NAME
  }

  // HTTP interceptor
  static get HTTP_INTERCEPTOR_URL() {
    return process.env.HTTP_INTERCEPTOR_URL
  }

  static get APP_MONITOR_URL() {
    return process.env.APP_MONITOR_URL
  }

  static get DATABASE_MONITOR_URL() {
    return process.env.DATABASE_MONITOR_URL
  }

  static get KUBEBLOCK_V5_UPGRADE_URL() {
    return process.env.KUBEBLOCK_V5_UPGRADE_URL
  }

  static get KUBEBLOCKS_TEMPLATE_VERSION(): 'kb8' | 'kb9' {
    return process.env.KUBEBLOCKS_TEMPLATE_VERSION === 'kb9' ? 'kb9' : 'kb8'
  }
}

export const LABEL_KEY_APP_ID = 'sealaf.dev/appid'

// Runtime constants
export const HTTP_METHODS = ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH']

export const CN_PUBLISHED_FUNCTIONS = '__functions__'
export const CN_PUBLISHED_CONF = '__conf__'

export const X_LAF_TRIGGER_TOKEN_KEY = 'x-laf-trigger-token'
export const X_LAF_DEVELOP_TOKEN_KEY = 'x-laf-develop-token'
export const APPLICATION_SECRET_KEY = 'SERVER_SECRET'

// Date & times
export const ONE_DAY_IN_SECONDS = 60 * 60 * 24 // 1 day in seconds
export const SEVEN_DAYS_IN_SECONDS = 60 * 60 * 24 * 7 // 7 days in seconds
export const ONE_MONTH_IN_SECONDS = 60 * 60 * 24 * 31 // 31 days in seconds
export const FOREVER_IN_SECONDS = 60 * 60 * 24 * 365 * 1000 // 1000 years in seconds
export const TASK_LOCK_INIT_TIME = new Date(0) // 1970-01-01 00:00:00
export const MILLISECONDS_PER_DAY = 60 * 60 * 24 * 1000 // 1 day in milliseconds
export const MILLISECONDS_PER_MINUTE = 60 * 1000 // 1 minute in milliseconds

// Resource units
export const CPU_UNIT = 1000
export const MB = 1024 * 1024
export const GB = 1024 * MB

// Recycle bin constants
export const STORAGE_LIMIT = 1000 // 1000 items

// HTTP interceptor
export const HTTP_INTERCEPTOR_TIMEOUT = 3000 // 3s

// KubeBlock v5 upgrade API
export const KUBEBLOCK_V5_UPGRADE_API_TIMEOUT = 3000 // 3s
