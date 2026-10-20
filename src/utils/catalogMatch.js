// Pairs a local product with a product from the other store (Club Pro) so
// its images can be pulled across. Strongest signal wins:
//   1. SKU            2. Fishbowl part number
//   3. name + brand + model + color   4. name + brand + model   5. name
// A tier only counts when it points at exactly one remote product, and the
// name tiers never pair two products whose SKU, color, brand or model are set
// on both sides but differ — that is a different variant.
//
// Products on both sides share this shape:
//   { id, name, altNames?: string[], sku, fishbowl, brand, model, color }

const looseKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

const namesOf = (p) => [...new Set([p.name, ...(p.altNames || [])].map(looseKey).filter(Boolean))]

function addTo(index, key, product) {
  if (!key) return
  if (!index.has(key)) index.set(key, [])
  const list = index.get(key)
  if (!list.includes(product)) list.push(product)
}

const MATCH_REASONS = {
  sku: 'SKU',
  fishbowl: 'Fishbowl #',
  full: 'Name + brand + model + color',
  nameBrandModel: 'Name + brand + model',
  name: 'Name',
}

function buildMatcher(remoteProducts) {
  const bySku = new Map()
  const byFishbowl = new Map()
  const byFull = new Map()
  const byNameBrandModel = new Map()
  const byName = new Map()

  for (const r of remoteProducts) {
    addTo(bySku, looseKey(r.sku), r)
    addTo(byFishbowl, looseKey(r.fishbowl), r)
    const brand = looseKey(r.brand)
    const model = looseKey(r.model)
    const color = looseKey(r.color)
    for (const n of namesOf(r)) {
      if (brand && model && color) addTo(byFull, `${n}|${brand}|${model}|${color}`, r)
      if (brand && model) addTo(byNameBrandModel, `${n}|${brand}|${model}`, r)
      addTo(byName, n, r)
    }
  }

  return function match(local) {
    const sku = looseKey(local.sku)
    if (sku) {
      const hits = bySku.get(sku) || []
      if (hits.length === 1) return { remote: hits[0], reason: 'sku' }
    }
    const fishbowl = looseKey(local.fishbowl)
    if (fishbowl) {
      const hits = byFishbowl.get(fishbowl) || []
      if (hits.length === 1) return { remote: hits[0], reason: 'fishbowl' }
    }

    const brand = looseKey(local.brand)
    const model = looseKey(local.model)
    const color = looseKey(local.color)
    // Fields set on both sides must agree; a blank on either side is no evidence.
    const agrees = (mine, theirs) => !mine || !looseKey(theirs) || looseKey(theirs) === mine
    const compatible = (r) =>
      agrees(sku, r.sku) && agrees(color, r.color) && agrees(brand, r.brand) && agrees(model, r.model)
    const names = namesOf(local)
    const tiers = [
      ['full', byFull, brand && model && color ? (n) => `${n}|${brand}|${model}|${color}` : null],
      ['nameBrandModel', byNameBrandModel, brand && model ? (n) => `${n}|${brand}|${model}` : null],
      ['name', byName, (n) => n],
    ]
    for (const [reason, index, keyFor] of tiers) {
      if (!keyFor) continue
      const hits = new Set()
      for (const n of names) for (const r of index.get(keyFor(n)) || []) if (compatible(r)) hits.add(r)
      if (hits.size === 1) return { remote: [...hits][0], reason }
      // Several equally good candidates: a weaker tier can only be more
      // ambiguous, so leave it for the admin to pick by hand.
      if (hits.size > 1) return null
    }
    return null
  }
}

module.exports = { looseKey, MATCH_REASONS, buildMatcher };
