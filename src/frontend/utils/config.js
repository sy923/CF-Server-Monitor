let apiBase = null
let apiBases = []
let wsBase = null

const stripTrailingSlash = (s) => String(s || '').replace(/\/+$/, '')

const toOrigin = (value) => {
  try {
    const u = new URL(value)
    return `${u.protocol}//${u.host}`
  } catch (_) {
    return null
  }
}

const computeWsBase = (origin) => {
  try {
    const u = new URL(origin)
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProto}//${u.host}`
  } catch (_) {
    return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
  }
}

const setApiBase = (value) => {
  if (Array.isArray(value)) {
    apiBases = value.map(v => stripTrailingSlash(v)).filter(v => v)
    apiBase = apiBases.length > 0 ? apiBases[0] : stripTrailingSlash(window.location.origin)
  } else {
    apiBases = []
    const cleaned = stripTrailingSlash(value)
    apiBase = cleaned || stripTrailingSlash(window.location.origin)
  }
  wsBase = computeWsBase(apiBase)
  window.__APP_API_BASE__ = apiBase
  window.__APP_WS_BASE__ = wsBase
  window.__APP_API_BASES__ = apiBases
  return apiBase
}

export const initConfig = async () => {
  setApiBase(window.location.origin)
  try {
    const res = await fetch(`/config.json?t=${Date.now()}`, {
      cache: 'no-cache',
      credentials: 'omit'
    })
    if (res && res.ok) {
      const data = await res.json()
      if (data && data.apiBase) {
        if (Array.isArray(data.apiBase)) {
          setApiBase(data.apiBase.filter(u => typeof u === 'string' && u.trim()))
        } else if (typeof data.apiBase === 'string' && data.apiBase.trim()) {
          setApiBase(data.apiBase.trim())
        }
      }
    }
  } catch (e) {
    // Network or parse failure -> keep the current-origin fallback
  }
  return apiBase
}

export const getApiBase = () => {
  if (apiBase) return apiBase
  if (window.__APP_API_BASE__) return window.__APP_API_BASE__
  return stripTrailingSlash(window.location.origin)
}

export const getApiBases = () => {
  if (apiBases.length > 0) return apiBases
  if (window.__APP_API_BASES__) return window.__APP_API_BASES__
  return []
}

export const getAllApiBases = () => {
  if (apiBases.length > 0) return apiBases
  if (window.__APP_API_BASES__) return window.__APP_API_BASES__
  return []
}

export const getWsBase = () => {
  if (wsBase) return wsBase
  if (window.__APP_WS_BASE__) return window.__APP_WS_BASE__
  return computeWsBase(getApiBase())
}

export const hasMultipleApiBases = () => {
  return getApiBases().length > 1
}

export default { initConfig, getApiBase, getApiBases, getAllApiBases, getWsBase, hasMultipleApiBases }
