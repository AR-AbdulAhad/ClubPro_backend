const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildMatcher } = require('./catalogMatch')

const remote = [
  { id: 1, name: '3 x 4 Universal Enclosure', sku: 'BC20R', brand: 'ClubPro', model: '2 Passenger Universal', color: 'Red' },
  { id: 2, name: '3 x 4 Universal Enclosure', sku: 'BC20B', brand: 'ClubPro', model: '2 Passenger Universal', color: 'Black' },
  { id: 3, name: 'Seat Cover', sku: '', brand: 'Club Car', model: 'DS', color: '' },
  { id: 4, name: 'Seat Cover', sku: '', brand: 'E-Z-GO', model: 'TXT', color: '' },
  { id: 5, name: 'Rain Bag', sku: '', fishbowl: 'FB-77', brand: 'Yamaha', model: 'Drive2', color: '' },
]
const match = buildMatcher(remote)

test('SKU wins, ignoring case and punctuation', () => {
  assert.equal(match({ name: 'Anything', sku: 'bc-20r' }).remote.id, 1)
  assert.equal(match({ name: 'Anything', sku: 'bc-20r' }).reason, 'sku')
})

test('Fishbowl part number is the second signal', () => {
  const m = match({ name: 'Different name', fishbowl: 'fb77' })
  assert.equal(m.remote.id, 5)
  assert.equal(m.reason, 'fishbowl')
})

test('name + brand + model + color picks the right color variant', () => {
  const m = match({ name: '3x4 Universal Enclosure', brand: 'clubpro', model: '2 Passenger Universal', color: 'black' })
  assert.equal(m.remote.id, 2)
  assert.equal(m.reason, 'full')
})

test('a different color is never matched by name', () => {
  assert.equal(match({ name: '3 x 4 Universal Enclosure', brand: 'ClubPro', model: '2 Passenger Universal', color: 'Tan' }), null)
})

test('a different SKU is never matched by name', () => {
  assert.equal(match({ name: '3 x 4 Universal Enclosure', sku: 'OTHER-1', brand: 'ClubPro', model: '2 Passenger Universal', color: 'Red' }), null)
})

test('same name for several brands only matches the right brand + model', () => {
  const m = match({ name: 'Seat Cover - E-Z-GO TXT', altNames: ['Seat Cover'], brand: 'EZGO', model: 'TXT' })
  assert.equal(m.remote.id, 4)
  assert.equal(m.reason, 'nameBrandModel')
  assert.equal(match({ name: 'Seat Cover', brand: 'Yamaha', model: 'Drive2' }), null)
})

test('ambiguous name with no brand/model is left for the admin', () => {
  assert.equal(match({ name: 'Seat Cover' }), null)
})

test('name alone matches when it is unique', () => {
  const m = match({ name: 'rain bag' })
  assert.equal(m.remote.id, 5)
  assert.equal(m.reason, 'name')
})
