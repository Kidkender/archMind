import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { join } from 'path'

const projectRoot = 'C:/Users/Admin/Desktop/DuckCode/New folder/obsidian-admin-laravel'
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

// Targets to inspect in full
const TARGETS = [
  'POST /$toVersionedPath($version, \'role\')/',   // create role — idempotency + auth + txn
  'GET /$toVersionedPath($version, \'auth\')/getUserInfo', // tenant propagation only
]

for (const relFile of routeFiles) {
  let skeletons
  try { skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap }) }
  catch { continue }

  for (const g of skeletons) {
    if (!TARGETS.some(t => g.entrypoint.includes(t.replace(/'/g, "'")))) continue

    const aug = augmentGraph(g, { projectRoot, config })
    console.log(`\n${'='.repeat(70)}`)
    console.log(`ENTRYPOINT: ${aug.entrypoint}`)
    console.log('NODES:')
    for (const n of aug.nodes) {
      console.log(`  id=${n.id}  type=${n.type}  symbol=${n.symbol}  file=${n.file ?? '~'}`)
    }
    console.log('EDGES:')
    for (const e of aug.edges) {
      console.log(`  ${e.from} --[${e.relation}]--> ${e.to}`)
    }
  }
}
