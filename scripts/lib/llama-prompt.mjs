import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

/**
 * @param {string} title
 * @param {{ value: string, label: string, hint?: string }[]} choices
 */
export async function pickOne(title, choices) {
  console.log(`\n${title}\n`)
  choices.forEach((c, i) => {
    const h = c.hint ? ` — ${c.hint}` : ''
    console.log(`  ${i + 1}) ${c.label}${h}`)
  })
  const rl = readline.createInterface({ input, output })
  let picked = null
  while (!picked) {
    const raw = (await rl.question('\nEnter number: ')).trim()
    const n = parseInt(raw, 10)
    if (n >= 1 && n <= choices.length) picked = choices[n - 1].value
    else console.log('Invalid choice, try again.')
  }
  rl.close()
  return picked
}

/**
 * @param {string} title
 * @param {{ value: string, label: string }[]} choices
 */
export async function pickMany(title, choices) {
  console.log(`\n${title}\n`)
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`))
  const rl = readline.createInterface({ input, output })
  let values = []
  while (!values.length) {
    const raw = (await rl.question('\nEnter numbers (comma-separated, e.g. 1,2): ')).trim()
    const nums = raw.split(/[\s,]+/).map((s) => parseInt(s, 10))
    values = nums
      .filter((n) => n >= 1 && n <= choices.length)
      .map((n) => choices[n - 1].value)
    if (!values.length) console.log('Pick at least one valid number.')
  }
  rl.close()
  return values
}

/** @param {string} question */
export async function confirm(question) {
  const rl = readline.createInterface({ input, output })
  const raw = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase()
  rl.close()
  return raw === 'y' || raw === 'yes'
}
