import assert from 'node:assert/strict'
import { inferTimezoneFromQuery } from './local-timezone.ts'

assert.equal(inferTimezoneFromQuery('what time is it in Tokyo'), 'Asia/Tokyo')
assert.equal(inferTimezoneFromQuery('time in Portugal'), 'Europe/Lisbon')
assert.equal(inferTimezoneFromQuery('what time is it'), null)
assert.equal(inferTimezoneFromQuery('time in Ulaanbaatar'), null)
assert.equal(inferTimezoneFromQuery('what time is in france right now ?'), 'Europe/Paris')

console.log('local-timezone.test.mjs: ok')
