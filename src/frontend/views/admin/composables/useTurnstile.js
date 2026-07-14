import { ref } from 'vue'
import { http } from '../../../utils/http'
import {
  clearTurnstileToken,
  fetchAllTurnstileConfigs,
  getTurnstileEnabledSites,
  hasSharedTurnstileVerified,
  hasTurnstileSiteKeyMismatch,
  isTurnstileValueEnabled,
  loadTurnstileScript,
  setTurnstileToken
} from '../../../utils/turnstile'

export function useTurnstile() {
  const turnstileEnabled = ref(false)
  const turnstileLoginEnabled = ref(false)
  const turnstileSiteKey = ref('')
  const turnstileToken = ref('')
  const turnstileVerified = ref(false)
  const turnstileBlocked = ref(false)

  const renderTurnstile = (containerSelector, siteKey, callbacks = {}) => {
    if (window.turnstile) {
      window.turnstile.render(containerSelector, {
        sitekey: siteKey,
        callback: (token) => {
          turnstileToken.value = token
          setTurnstileToken(token)
          callbacks.onSuccess?.(token)
        },
        errorCallback: () => {
          turnstileToken.value = ''
          clearTurnstileToken()
          callbacks.onError?.()
        },
        expiredCallback: () => {
          turnstileToken.value = ''
          clearTurnstileToken()
          callbacks.onExpired?.()
        }
      })
    }
  }

  const resetTurnstile = (containerSelector) => {
    if (window.turnstile) {
      window.turnstile.reset(containerSelector)
    }
  }

  const applyTurnstileConfig = async (config, sharedSiteKey = '') => {
    if (!config) return false

    turnstileEnabled.value = isTurnstileValueEnabled(config.turnstile_enabled)
    turnstileLoginEnabled.value = isTurnstileValueEnabled(config.turnstile_login_enabled)

    const requiresTurnstile = turnstileEnabled.value || turnstileLoginEnabled.value
    turnstileSiteKey.value = requiresTurnstile ? (sharedSiteKey || config.turnstile_site_key || '') : ''
    turnstileVerified.value = turnstileEnabled.value && (config.verified === true || hasSharedTurnstileVerified())

    if (turnstileSiteKey.value && (turnstileLoginEnabled.value || (turnstileEnabled.value && !turnstileVerified.value))) {
      await loadTurnstileScript()
      return true
    }
    return false
  }

  const loadTurnstileConfig = async (selectedApiIndex, isMultipleMode, loginError, trans) => {
    try {
      turnstileEnabled.value = false
      turnstileLoginEnabled.value = false
      turnstileSiteKey.value = ''
      turnstileToken.value = ''
      turnstileVerified.value = false
      turnstileBlocked.value = false
      if (loginError) loginError.value = ''
      clearTurnstileToken()

      if (isMultipleMode) {
        const results = await fetchAllTurnstileConfigs()
        const enabledSites = getTurnstileEnabledSites(results, 'login')

        if (hasTurnstileSiteKeyMismatch(enabledSites)) {
          turnstileBlocked.value = true
          if (loginError && trans) loginError.value = trans.value.turnstileSiteKeyMismatchDesc
          return
        }

        const selectedResult = results[selectedApiIndex]
        const selectedConfig = selectedResult && !selectedResult.error ? selectedResult.data : null
        await applyTurnstileConfig(selectedConfig, enabledSites[0]?.siteKey || '')
        return
      }

      const result = await http.getByIndex('/api/config', selectedApiIndex, { includeAuth: true, includeTurnstile: true })
      if (!result.error) {
        await applyTurnstileConfig(result.data)
      }
    } catch (e) {
      console.error('Failed to load Turnstile config:', e)
    }
  }

  const clearTurnstile = () => {
    turnstileToken.value = ''
    clearTurnstileToken()
  }

  return {
    turnstileEnabled,
    turnstileLoginEnabled,
    turnstileSiteKey,
    turnstileToken,
    turnstileVerified,
    turnstileBlocked,
    hasSharedTurnstileVerified,
    loadTurnstileConfig,
    renderTurnstile,
    resetTurnstile,
    clearTurnstile
  }
}
