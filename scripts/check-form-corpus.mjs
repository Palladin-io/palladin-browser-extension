import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = resolve('tests/fixtures/forms')
const coverage = JSON.parse(readFileSync(`${directory}/coverage.json`, 'utf8'))
// Main also contains standalone README-only regressions. They are not corpus
// observations until explicitly indexed by case.json and the coverage ledger.
const specimens = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(`${directory}/${entry.name}/case.json`))
  .map(entry => JSON.parse(readFileSync(`${directory}/${entry.name}/case.json`, 'utf8')))
function fullFlowObserved(service, flow) {
  if (service[flow] === 'not-offered') {
    const evidence = service.evidence?.[flow]
    return evidence && !Array.isArray(evidence) && typeof evidence.source === 'string'
      && evidence.source.startsWith('https://') && typeof evidence.reason === 'string' && evidence.reason.trim().length > 0
  }
  if (service[flow] !== 'observed') return false
  const evidence = service.evidence?.[flow]
  return Array.isArray(evidence) && specimens.some(specimen => specimen.service === service.id
    && specimen.flow === flow && !specimen.stage && specimen.expected?.capture?.kind === flow
    && service.fixtures?.includes(specimen.id)
    && evidence.some(item => item.fixture === specimen.id && item.source === specimen.source.url
      && item.observedAt === specimen.source.observedAt && !item.stage))
}
const invalidClaims = coverage.services.flatMap(service => ['login', 'registration']
  .filter(flow => ['observed', 'not-offered'].includes(service[flow]) && !fullFlowObserved(service, flow))
  .map(flow => `${service.id}:${flow}`))
const missing = []
const regions = Object.fromEntries(Object.entries(coverage.targets).map(([region, target]) => {
  const services = coverage.services.filter(service => service.regions.includes(region))
  const count = new Set(services.map(service => service.id)).size
  const fullyObserved = new Set(services.filter(service => ['login', 'registration'].every(flow =>
    fullFlowObserved(service, flow))).map(service => service.id)).size
  if (count !== target || fullyObserved !== target) missing.push(region)
  return [region, { target, selected: count, fullyObserved }]
}))
console.log(JSON.stringify({ regions, specimens: specimens.length,
  observedServices: new Set(specimens.map(specimen => specimen.service)).size,
  partialStages: specimens.filter(specimen => specimen.stage).length,
  complete: missing.length === 0 && invalidClaims.length === 0,
  invalidClaims,
  note: 'Observation counts are not test results or production authentication acceptance.' }, null, 2))
if (process.argv.includes('--complete') && missing.length) {
  console.error(`Incomplete regional coverage: ${missing.join(', ')}`)
  process.exitCode = 1
}
if (invalidClaims.length) {
  console.error(`Observation claims lack matching full-flow specimens or evidence: ${invalidClaims.join(', ')}`)
  process.exitCode = 1
}
