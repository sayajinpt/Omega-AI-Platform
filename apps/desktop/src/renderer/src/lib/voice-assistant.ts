/** Web Speech API helpers for Omega voice mode. */

export function speechRecognitionAvailable(): boolean {
  return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
}

export function speechSynthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Strip markdown / tool fences so OS TTS reads natural sentences. */
export function plainTextForSpeech(raw: string): string {
  let t = raw.trim()
  if (!t) return ''
  t = t.replace(/```choices[\s\S]*?```/gi, ' ')
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/`[^`]+`/g, ' ')
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  t = t.replace(/^#{1,6}\s+/gm, '')
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*]+)\*/g, '$1')
  t = t.replace(/^>\s+/gm, '')
  t = t.replace(/\s+/g, ' ').trim()
  return t.slice(0, 4000)
}

export function stopSpeaking(): void {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
}

export function startListening(onResult: (text: string, final: boolean) => void): () => void {
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
  if (!SR) {
    onResult('', true)
    return () => {}
  }
  const rec = new SR()
  rec.continuous = false
  rec.interimResults = true
  rec.lang = navigator.language || 'en-US'
  rec.onresult = (raw: unknown) => {
    const ev = raw as {
      resultIndex: number
      results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } }
    }
    let text = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      text += ev.results[i][0].transcript
    }
    const final = ev.results[ev.results.length - 1]?.isFinal ?? false
    onResult(text.trim(), final)
  }
  rec.onerror = () => onResult('', true)
  rec.start()
  return () => {
    try {
      rec.stop()
    } catch {
      /* ignore */
    }
  }
}

export function speakText(text: string): void {
  const spoken = plainTextForSpeech(text)
  if (!spoken || !speechSynthesisAvailable()) return
  stopSpeaking()
  const u = new SpeechSynthesisUtterance(spoken)
  u.lang = navigator.language || 'en-US'
  u.rate = 1
  u.onstart = () => {
    window.dispatchEvent(new CustomEvent('omega:voice-speaking', { detail: true }))
  }
  u.onend = u.onerror = () => {
    window.dispatchEvent(new CustomEvent('omega:voice-speaking', { detail: false }))
  }
  window.speechSynthesis.speak(u)
}

type SpeechRecognitionCtor = new () => {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((ev: unknown) => void) | null
  onerror: (() => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}
