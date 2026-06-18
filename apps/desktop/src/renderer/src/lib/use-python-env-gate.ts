const STORAGE_KEY = 'omega:python-env-satisfied'

function storeSatisfied(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
    sessionStorage.setItem(STORAGE_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Call after successful first-time Python / Content Studio setup. */
export function markPythonEnvSatisfied(): void {
  storeSatisfied()
}
