import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { join } from 'path'
import { readdirSync } from 'fs'

const projectRoot = 'C:/Users/Admin/Desktop/DuckCode/New folder/obsidian-admin-laravel'
const config = loadProjectConfig(projectRoot)
const { aliasMap } = resolveAliasMap(projectRoot, config)

// Sub-files that api.php requires
const subFiles = readdirSync(join(projectRoot, 'routes/api'))
  .filter(f => f.endsWith('.php'))
  .map(f => `routes/api/${f}`)

console.log('Sub-files found:', subFiles)

let total = 0, notable = 0
for (const relFile of subFiles) {
  let skeletons
  try {
    skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  } catch (e) {
    console.log(`ERROR parsing ${relFile}: ${e.message}`)
    continue
  }
  total += skeletons.length
  for (const g of skeletons) {
    const aug = augmentGraph(g, { projectRoot, config })
    const auth = aug.nodes.filter(n => ['authorization_check','authentication_gate','policy'].includes(n.type))
    const svc  = aug.nodes.filter(n => n.type === 'service_call')
    const txn  = aug.nodes.filter(n => n.type === 'transaction_boundary')
    const fr   = aug.nodes.filter(n => n.type === 'form_request')
    if (auth.length + svc.length + txn.length > 0) {
      notable++
      console.log(`\n  ${aug.entrypoint}  (${aug.nodes.length} nodes)  [${relFile}]`)
      auth.forEach(n => console.log(`    [${n.type.padEnd(20)}] ${n.symbol}`))
      fr.forEach(n   => console.log(`    [form_request         ] ${n.symbol}`))
      svc.forEach(n  => console.log(`    [service_call         ] ${n.symbol}  file=${n.file ?? 'UNRESOLVED'}`))
      txn.forEach(n  => console.log(`    [transaction_boundary ] ${n.symbol}`))
    }
  }
}
console.log(`\nSUMMARY: ${total} routes parsed, ${notable} with notable nodes`)
